import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Context } from 'cordis';
import { AgentPeripheralStatus } from '@dsh-hid/protocol';
import {
  PeripheralServerService,
  type ApprovalOutcome,
  type ApprovalRequestEvent,
} from '../src/index.js';

describe('Real DSH Events & ApprovalArbiter Waterfall Integration', () => {
  let ctx: Context;
  let service: PeripheralServerService;

  beforeEach(() => {
    ctx = new Context();
    service = new PeripheralServerService(ctx, {
      port: 0,
      forceArbitration: true,
    });
  });

  afterEach(async () => {
    if (service) {
      await service.stop();
    }
  });

  it('tracks real DSH api-session/*, session/*, agent/*, and tools/* events accurately', async () => {
    // 1. api-session/added allocates slot 1
    ctx.emit('api-session/added', { id: 'dsh-sess-1', running: false });
    expect(service.router.getSlot(1)?.sessionId).toBe('dsh-sess-1');
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.IDLE);

    // 2. session/event turn/start -> RUNNING
    ctx.emit('session/event', { id: 'dsh-sess-1' }, { type: 'turn/start' });
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.RUNNING);

    // 3. tools/pre-execute waterfall sets activeTool and delegates to next()
    const preDecision = await ctx.waterfall(
      'tools/pre-execute',
      { name: 'bash', agent: { id: 'agent-1', session: { id: 'dsh-sess-1' } } },
      async () => 'allow'
    );
    expect(preDecision).toBe('allow');
    expect(service.router.getSlot(1)?.activeTool).toBe('bash');

    // 4. tools/result clears activeTool
    ctx.emit('tools/result', { name: 'bash', agent: { id: 'agent-1', session: { id: 'dsh-sess-1' } } });
    expect(service.router.getSlot(1)?.activeTool).toBeUndefined();

    // 5. session/event tool/call & tool/result
    ctx.emit(
      'session/event',
      { id: 'dsh-sess-1' },
      { type: 'tool/call', data: { toolName: 'edit_file' } }
    );
    expect(service.router.getSlot(1)?.activeTool).toBe('edit_file');

    ctx.emit('session/event', { id: 'dsh-sess-1' }, { type: 'tool/result' });
    expect(service.router.getSlot(1)?.activeTool).toBeUndefined();

    // 6. session/event turn/end -> COMPLETED
    ctx.emit('session/event', { id: 'dsh-sess-1' }, { type: 'turn/end' });
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.COMPLETED);

    // 7. agent/error object payload -> ERROR
    ctx.emit('agent/error', {
      agent: { id: 'agent-1', session: { id: 'dsh-sess-1' } },
      turn: 1,
      step: 2,
      error: new Error('rate limit'),
    });
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.ERROR);

    // 8. api-session/removed releases slot
    ctx.emit('api-session/removed', 'dsh-sess-1');
    expect(service.router.getSlot(1)?.sessionId).toBeNull();
    expect(service.router.getSlot(1)?.status).toBe(AgentPeripheralStatus.INACTIVE);
  });

  it('Hardware wins approval race: resolves allowed-once and aborts derived UI signal', async () => {
    let uiDerivedReq: ApprovalRequestEvent | null = null;
    let uiSignalAborted = false;

    // Downstream listener simulating DSH `remotes` forwarding to Web UI
    ctx.on('approval/request', async (req) => {
      uiDerivedReq = req;
      req.signal?.addEventListener('abort', () => {
        uiSignalAborted = true;
      });
      // Simulate UI user taking a long time (never clicking before hardware)
      return await new Promise<ApprovalOutcome>((resolve) => {
        req.signal?.addEventListener('abort', () => resolve('cancelled'), { once: true });
      });
    });

    const callerAc = new AbortController();
    const req: ApprovalRequestEvent = {
      agent: { id: 'agent-hw', session: { id: 'sess-hw' } },
      toolName: 'run_command',
      reason: 'Execute rm -rf dist?',
      signal: callerAc.signal,
    };

    const decisionPromise = ctx.waterfall(
      'approval/request',
      req,
      async (): Promise<ApprovalOutcome> => 'unavailable'
    );

    await new Promise((r) => setTimeout(r, 20));

    // Verify slot is now NEEDS_INPUT with prompt & options
    const slot = service.router.getSlotBySessionId('sess-hw');
    expect(slot?.status).toBe(AgentPeripheralStatus.NEEDS_INPUT);
    expect(slot?.activeTool).toBe('run_command');
    expect(slot?.question?.prompt).toBe('Execute rm -rf dist?');
    expect(slot?.question?.options).toEqual(['ACCEPT', 'REJECT']);

    // Verify derivedReq has only enumerable string keys (DSH projectRemoteEventRequest compliance)
    expect(uiDerivedReq).not.toBeNull();
    for (const key of Reflect.ownKeys(uiDerivedReq!)) {
      expect(typeof key).toBe('string');
      const desc = Object.getOwnPropertyDescriptor(uiDerivedReq!, key);
      expect(desc?.enumerable).toBe(true);
    }

    // Physical keyboard user presses Enter/Y (ACCEPT)
    const settled = service.arbiter.resolveBySlotOption(slot!.slotIndex, 'ACCEPT');
    expect(settled).toBe(true);

    const outcome = await decisionPromise;
    expect(outcome).toBe('allowed-once');
    // Derived signal passed to Web UI must be aborted so Gateway withdraws the UI card
    expect(uiSignalAborted).toBe(true);
    // Slot must return from NEEDS_INPUT to RUNNING with question cleared
    expect(service.router.getSlot(slot!.slotIndex)?.status).toBe(AgentPeripheralStatus.RUNNING);
    expect(service.router.getSlot(slot!.slotIndex)?.question).toBeUndefined();
  });

  it('Web UI wins approval race: clears hardware NEEDS_INPUT state immediately', async () => {
    let resolveUi!: (outcome: ApprovalOutcome) => void;
    ctx.on('approval/request', async () => {
      return await new Promise<ApprovalOutcome>((resolve) => {
        resolveUi = resolve;
      });
    });

    const req: ApprovalRequestEvent = {
      agent: { id: 'agent-ui', session: { id: 'sess-ui' } },
      toolName: 'write_file',
      reason: 'Overwrite config.json?',
    };

    const decisionPromise = ctx.waterfall(
      'approval/request',
      req,
      async (): Promise<ApprovalOutcome> => 'unavailable'
    );

    await new Promise((r) => setTimeout(r, 20));
    const slot = service.router.getSlotBySessionId('sess-ui');
    expect(slot?.status).toBe(AgentPeripheralStatus.NEEDS_INPUT);
    expect(service.arbiter.hasPendingApproval('sess-ui')).toBe(true);

    // User clicks "Reject" in Web UI
    resolveUi('rejected');
    const outcome = await decisionPromise;
    expect(outcome).toBe('rejected');

    // Hardware pending approval is cleaned up and slot returns to RUNNING
    expect(service.arbiter.hasPendingApproval('sess-ui')).toBe(false);
    expect(service.router.getSlot(slot!.slotIndex)?.status).toBe(AgentPeripheralStatus.RUNNING);
    expect(service.router.getSlot(slot!.slotIndex)?.question).toBeUndefined();
  });

  it('waits for physical keyboard when Web UI is closed (downstream returns unavailable)', async () => {
    // No downstream Web UI listener registered -> waterfall fallback returns 'unavailable' immediately
    const req: ApprovalRequestEvent = {
      agent: { id: 'agent-headless', session: { id: 'sess-headless' } },
      toolName: 'git_push',
      reason: 'Push to origin/main?',
    };

    const decisionPromise = ctx.waterfall(
      'approval/request',
      req,
      async (): Promise<ApprovalOutcome> => 'unavailable'
    );

    await new Promise((r) => setTimeout(r, 30));
    // Must still be waiting for the physical keyboard rather than failing closed in 0ms!
    const slot = service.router.getSlotBySessionId('sess-headless');
    expect(slot?.status).toBe(AgentPeripheralStatus.NEEDS_INPUT);
    expect(service.arbiter.hasPendingApproval('sess-headless')).toBe(true);

    // User presses Esc/N (REJECT) on physical keyboard
    service.arbiter.resolveBySlotOption(slot!.slotIndex, 'REJECT');
    const outcome = await decisionPromise;
    expect(outcome).toBe('rejected');
  });

  it('degrades gracefully to next() when no peripheral is connected', async () => {
    const localCtx = new Context();
    const localService = new PeripheralServerService(localCtx, {
      port: 0,
      forceArbitration: false, // No WebSocket clients connected
    });

    localCtx.on('approval/request', async () => 'allowed-once');

    const outcome = await localCtx.waterfall(
      'approval/request',
      {
        agent: { id: 'agent-no-hw', session: { id: 'sess-no-hw' } },
        toolName: 'bash',
      },
      async (): Promise<ApprovalOutcome> => 'unavailable'
    );

    expect(outcome).toBe('allowed-once');
    await localService.stop();
  });
});
