import type { Context } from 'cordis';
import {
  AgentPeripheralStatus,
  type OptionAction,
} from '@dsh-hid/protocol';
import type { SessionRouter } from './router.js';

/**
 * Closed approval outcomes matching `@deepseek-ai/dsh-user-approval`.
 */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * Minimal structural Agent reference compatible with `@deepseek-ai/dsh-agent`.
 */
export interface DshAgentRef {
  readonly id: string;
  readonly session?: {
    readonly id: string;
  };
  readonly ctx?: Context;
}

/**
 * Approval waterfall request payload matching `@deepseek-ai/dsh-user-approval`.
 */
export interface ApprovalRequestEvent {
  readonly agent: DshAgentRef;
  readonly toolName: string;
  readonly callId?: string;
  readonly reason?: string;
  readonly displayReason?: {
    readonly en: string;
    readonly [locale: string]: string;
  };
  readonly signal?: AbortSignal;
}

export interface ApprovalArbiterOptions {
  /**
   * Returns true when at least one hardware peripheral daemon is connected,
   * or when arbitration is explicitly forced in headless unit tests.
   */
  isPeripheralAvailable: () => boolean;
  /**
   * Whether to auto-allocate a slot if the requesting agent session has not been bound yet.
   */
  autoBindSlots?: boolean;
}

interface PendingApprovalEntry {
  readonly sessionId: string;
  readonly slotIndex: number;
  readonly toolName: string;
  readonly childController: AbortController;
  readonly resolveHardware: (outcome: ApprovalOutcome) => void;
}

/**
 * ApprovalArbiter coordinates concurrent human-in-the-loop tool approvals between
 * the DSH Web/Desktop UI (`remotes` waterfall) and the physical HID peripheral (`dsh-daemon`).
 *
 * Key guarantees (per DSH `user-approval` & `api/gateway` architecture):
 * 1. Uses a WeakSet to track derived requests so `Reflect.ownKeys(derivedReq)`
 *    contains only lossless JSON properties (`projectRemoteEventRequest` compliance).
 * 2. When no peripheral daemon is connected (`!isPeripheralAvailable()`), immediately
 *    delegates via `next()` with zero overhead.
 * 3. First responder wins (`UI` vs `Hardware`):
 *    - If Hardware responds first (`peripheral/selectOption` or `peripheral/abort`),
 *      `childController.abort('settled')` cancels the derived signal so DSH Gateway
 *      withdraws the pending Web UI approval card.
 *    - If Web UI responds first (`allowed-once` or `rejected`), the hardware slot's
 *      `NEEDS_INPUT` prompt is cleared immediately and the keyboard returns to `RUNNING`.
 *    - If Web UI returns `'unavailable'` (e.g., no browser tab open), the arbiter waits
 *      for the physical keyboard decision rather than failing closed prematurely.
 */
export class ApprovalArbiter {
  private readonly ctx: Context;
  private readonly router: SessionRouter;
  private readonly options: ApprovalArbiterOptions;
  private readonly arbitratedRequests = new WeakSet<object>();
  private readonly pendingBySession = new Map<string, PendingApprovalEntry>();

  constructor(ctx: Context, router: SessionRouter, options: ApprovalArbiterOptions) {
    this.ctx = ctx;
    this.router = router;
    this.options = options;
  }

  /**
   * Resolves canonical session ID from a DSH Agent reference.
   */
  public static resolveSessionId(agent: DshAgentRef): string {
    return agent.session?.id ?? agent.id;
  }

  /**
   * Registers the `{ prepend: true }` waterfall interceptor on `approval/request`.
   */
  public attach(): () => boolean {
    const self = this;
    return this.ctx.on(
      'approval/request',
      async function (
        this: unknown,
        req: ApprovalRequestEvent,
        next: () => Promise<ApprovalOutcome>
      ): Promise<ApprovalOutcome> {
        return await self.handleApprovalRequest(this, req, next);
      },
      { prepend: true }
    );
  }

  /**
   * Handles an incoming `approval/request` waterfall invocation.
   */
  public async handleApprovalRequest(
    scopeCarrier: unknown,
    req: ApprovalRequestEvent,
    next: () => Promise<ApprovalOutcome>
  ): Promise<ApprovalOutcome> {
    // 1. Re-entered derived request passes straight through to downstream listeners (e.g. `remotes` -> Web UI)
    if (this.arbitratedRequests.has(req)) {
      return await next();
    }

    // 2. Respect caller pre-cancellation
    if (req.signal?.aborted) {
      return 'cancelled';
    }

    // 3. Graceful degradation when no peripheral is connected
    if (!this.options.isPeripheralAvailable()) {
      return await next();
    }

    const sessionId = ApprovalArbiter.resolveSessionId(req.agent);
    let slot = this.router.getSlotBySessionId(sessionId);
    if (!slot && (this.options.autoBindSlots ?? true)) {
      slot = this.router.allocateSlot(sessionId, AgentPeripheralStatus.RUNNING);
    }
    if (!slot) {
      return await next();
    }

    // 4. Construct derived request with a child AbortController and zero extra own properties
    const childController = new AbortController();
    const combinedSignal = req.signal
      ? AbortSignal.any([req.signal, childController.signal])
      : childController.signal;

    const derivedReq: ApprovalRequestEvent = {
      ...req,
      signal: combinedSignal,
    };
    this.arbitratedRequests.add(derivedReq);

    // 5. Broadcast NEEDS_INPUT + question options to the peripheral daemon
    const promptText =
      req.displayReason?.en ??
      req.reason ??
      `Approve tool ${req.toolName}?`;

    this.router.updateSlot(slot.slotIndex, {
      status: AgentPeripheralStatus.NEEDS_INPUT,
      activeTool: req.toolName,
      question: {
        prompt: promptText,
        options: ['ACCEPT', 'REJECT'],
      },
    });

    // 6. Create hardware answerer promise
    let resolveHw!: (outcome: ApprovalOutcome) => void;
    const hwPromise = new Promise<ApprovalOutcome>((resolve) => {
      resolveHw = resolve;
    });

    const entry: PendingApprovalEntry = {
      sessionId,
      slotIndex: slot.slotIndex,
      toolName: req.toolName,
      childController,
      resolveHardware: resolveHw,
    };
    this.pendingBySession.set(sessionId, entry);

    const onCallerAbort = () => {
      resolveHw('cancelled');
    };
    req.signal?.addEventListener('abort', onCallerAbort, { once: true });

    // 7. Re-enter `approval/request` waterfall so downstream UI receives `derivedReq`
    const targetCtx = req.agent.ctx ?? this.ctx;
    const uiPromise: Promise<ApprovalOutcome> = Promise.resolve()
      .then(() => {
        if (scopeCarrier && (typeof scopeCarrier === 'object' || typeof scopeCarrier === 'function')) {
          return targetCtx.waterfall(
            scopeCarrier as never,
            'approval/request',
            derivedReq,
            () => Promise.resolve<ApprovalOutcome>('unavailable')
          );
        }
        return targetCtx.waterfall(
          'approval/request',
          derivedReq,
          () => Promise.resolve<ApprovalOutcome>('unavailable')
        );
      })
      .catch((): ApprovalOutcome => 'unavailable');

    try {
      const outcome = await this.raceAnswerers(uiPromise, hwPromise);
      return outcome;
    } finally {
      req.signal?.removeEventListener('abort', onCallerAbort);
      if (this.pendingBySession.get(sessionId) === entry) {
        this.pendingBySession.delete(sessionId);
      }
      if (!childController.signal.aborted) {
        childController.abort('settled');
      }
      // Restore slot from NEEDS_INPUT to RUNNING if still in NEEDS_INPUT
      const currentSlot = this.router.getSlotBySessionId(sessionId);
      if (currentSlot && currentSlot.status === AgentPeripheralStatus.NEEDS_INPUT) {
        this.router.updateSlot(currentSlot.slotIndex, {
          status: AgentPeripheralStatus.RUNNING,
          question: undefined,
        });
      }
    }
  }

  /**
   * Races the Web UI waterfall against the Hardware peripheral answerer.
   * If one side immediately resolves to `'unavailable'` (e.g. headless mode with no Web UI open),
   * waits for the other active answerer instead of prematurely failing closed.
   */
  private async raceAnswerers(
    uiPromise: Promise<ApprovalOutcome>,
    hwPromise: Promise<ApprovalOutcome>
  ): Promise<ApprovalOutcome> {
    type TaggedOutcome = { source: 'ui' | 'hw'; outcome: ApprovalOutcome };

    const taggedUi = uiPromise.then((outcome): TaggedOutcome => ({ source: 'ui', outcome }));
    const taggedHw = hwPromise.then((outcome): TaggedOutcome => ({ source: 'hw', outcome }));

    const first = await Promise.race([taggedUi, taggedHw]);
    if (first.outcome !== 'unavailable') {
      return first.outcome;
    }

    // First responder returned 'unavailable'; wait for the other responder
    return first.source === 'ui' ? await hwPromise : await uiPromise;
  }

  /**
   * Resolves a pending approval from a physical peripheral button press (`peripheral/selectOption`).
   * Returns true if a pending approval was matched and settled.
   */
  public resolveBySlotOption(slotIndex: number, action: OptionAction): boolean {
    const slot = this.router.getSlot(slotIndex);
    if (!slot?.sessionId) return false;
    return this.resolveBySessionOption(slot.sessionId, action);
  }

  /**
   * Resolves a pending approval by sessionId (`ACCEPT` | `ALWAYS_ALLOW` -> `'allowed-once'`, `REJECT` -> `'rejected'`).
   */
  public resolveBySessionOption(sessionId: string, action: OptionAction): boolean {
    const entry = this.pendingBySession.get(sessionId);
    if (!entry) return false;

    const outcome: ApprovalOutcome =
      action === 'ACCEPT' || action === 'ALWAYS_ALLOW' ? 'allowed-once' : 'rejected';
    entry.resolveHardware(outcome);
    return true;
  }

  /**
   * Cancels a pending approval from a physical peripheral abort (`peripheral/abort`).
   */
  public cancelBySlot(slotIndex: number): boolean {
    const slot = this.router.getSlot(slotIndex);
    if (!slot?.sessionId) return false;
    const entry = this.pendingBySession.get(slot.sessionId);
    if (!entry) return false;

    entry.resolveHardware('cancelled');
    return true;
  }

  /**
   * Returns true if the given session currently has an active arbitrated approval request.
   */
  public hasPendingApproval(sessionId: string): boolean {
    return this.pendingBySession.has(sessionId);
  }

  /**
   * Returns the number of currently pending approval requests.
   */
  public getPendingCount(): number {
    return this.pendingBySession.size;
  }
}
