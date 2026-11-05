import { Context, Service } from 'cordis';
import {
  AgentPeripheralStatus,
  type BrainpowerLevel,
  type BrainpowerDirection,
  type OptionAction,
  type SlotInfo,
  type TransportChangedParams,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_PATH,
} from '@dsh-hid/protocol';
import { SessionRouter } from './router.js';
import { PeripheralWsServer, type PeripheralRpcHandler } from './ws-server.js';
import { DaemonManager } from './daemon-manager.js';
import {
  ApprovalArbiter,
  type ApprovalOutcome,
  type ApprovalRequestEvent,
  type DshAgentRef,
} from './arbiter.js';
import {
  bindCordisLocale,
  getLocaleService,
  PERIPHERAL_CATALOGS,
  PERIPHERAL_NAMESPACE,
  type CordisLocaleBinding,
} from './i18n/index.js';

export interface PeripheralServerConfig {
  host?: string;
  port?: number;
  path?: string;
  totalSlots?: number;
  autoBindSlots?: boolean;
  /**
   * When true, `ApprovalArbiter` intercepts `approval/request` even if no WebSocket
   * client is currently connected (useful for in-process unit testing).
   */
  forceArbitration?: boolean;
  /**
   * Automatically start and manage the hardware daemon process alongside the Cordis plugin.
   * Defaults to true in live runtime; defaults to false in unit testing (Vitest).
   */
  autoStartDaemon?: boolean;
  /**
   * Optional custom path to the daemon binary or CLI script.
   */
  daemonPath?: string;
  /**
   * Optional custom CLI arguments for the daemon.
   */
  daemonArgs?: string[];
  /**
   * Whether the peripheral service is enabled.
   * If false, the server enters a dormant state without binding ports or spawning daemons.
   * Defaults to true.
   */
  enabled?: boolean;
}

export interface DshSessionSummary {
  readonly id?: string;
  readonly sessionId?: string;
  readonly running?: boolean;
  readonly formatStatus?: string;
  readonly blank?: boolean;
  readonly agentAvailable?: boolean;
}

export interface DshSessionRef {
  readonly id: string;
}

export interface DshSessionEventPayload {
  readonly type: string;
  readonly data?: Record<string, unknown>;
}

export interface DshToolExecutionPayload {
  readonly name?: string;
  readonly toolName?: string;
  readonly agent?: DshAgentRef;
}

const BRAINPOWER_LEVELS: BrainpowerLevel[] = ['low', 'medium', 'high', 'max'];

function adjustBrainpower(
  current: BrainpowerLevel = 'medium',
  direction?: BrainpowerDirection,
  explicitLevel?: BrainpowerLevel
): BrainpowerLevel {
  if (explicitLevel && BRAINPOWER_LEVELS.includes(explicitLevel)) {
    return explicitLevel;
  }

  const currentIndex = BRAINPOWER_LEVELS.indexOf(current);
  if (direction === 'stepUp') {
    const nextIndex = Math.min(BRAINPOWER_LEVELS.length - 1, currentIndex + 1);
    return BRAINPOWER_LEVELS[nextIndex]!;
  } else if (direction === 'stepDown') {
    const prevIndex = Math.max(0, currentIndex - 1);
    return BRAINPOWER_LEVELS[prevIndex]!;
  }

  return current;
}

function extractSessionId(target: string | DshAgentRef | DshSessionRef | undefined | null): string | null {
  if (!target) return null;
  if (typeof target === 'string') return target;
  if ('session' in target && target.session?.id) return target.session.id;
  if ('id' in target && typeof target.id === 'string') return target.id;
  return null;
}

export class PeripheralServerService extends Service {
  public static readonly inject = [];

  public readonly router: SessionRouter;
  public readonly wsServer: PeripheralWsServer;
  public readonly arbiter: ApprovalArbiter;
  public readonly daemonManager: DaemonManager;
  public readonly localeBinding: CordisLocaleBinding;
  private readonly autoBindSlots: boolean;
  private readonly forceArbitration: boolean;
  private readonly autoStartDaemon: boolean;
  private enabled: boolean;
  private isStarted: boolean = false;
  private startPromise: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private transportState: TransportChangedParams = {
    transport: 'disconnected',
    capabilities: {
      rgb: false,
      keys: false,
      ledBlink: false,
      wireless: false,
    },
  };

  constructor(ctx: Context, config?: PeripheralServerConfig) {
    super(ctx, 'peripheralServer');

    this.localeBinding = bindCordisLocale(
      getLocaleService(ctx),
      PERIPHERAL_NAMESPACE,
      PERIPHERAL_CATALOGS
    );

    this.autoBindSlots = config?.autoBindSlots ?? true;
    this.forceArbitration = config?.forceArbitration ?? false;
    this.enabled = config?.enabled ?? true;
    this.router = new SessionRouter({ totalSlots: config?.totalSlots });

    const host = config?.host ?? DEFAULT_HOST;
    const port = config?.port ?? DEFAULT_PORT;
    const wsPath = config?.path ?? DEFAULT_PATH;
    const wsUrl = `ws://${host}:${port}${wsPath}`;

    this.daemonManager = new DaemonManager({
      wsUrl,
      daemonPath: config?.daemonPath,
      daemonArgs: config?.daemonArgs,
    });

    const isVitest = typeof process !== 'undefined' && (process.env.VITEST === 'true' || process.env.NODE_ENV === 'test');
    this.autoStartDaemon = config?.autoStartDaemon ?? (!isVitest);

    const rpcHandler: PeripheralRpcHandler = {
      getInitialSnapshot: () => ({
        ...this.router.getSnapshot(),
        transportState: this.transportState,
      }),
      onTransportChanged: (params: TransportChangedParams) => {
        this.transportState = params;
        this.wsServer.broadcastTransportChanged(params);
        this.ctx.emit('peripheral/transport-changed', params);
      },
      onSwitchFocus: async (slotIndex: number) => {
        let currentSlot = this.router.getSlot(slotIndex);
        if (currentSlot?.status === AgentPeripheralStatus.COMPLETED) {
          currentSlot =
            this.router.updateSlot(slotIndex, { status: AgentPeripheralStatus.IDLE }) ?? currentSlot;
        }
        const wasAlreadyFocused = this.router.getFocusedSlot() === slotIndex;
        const ok = this.router.switchFocus(slotIndex);
        if (!ok) {
          throw new Error(`Failed to switch focus: invalid slot ${slotIndex}`);
        }
        if (wasAlreadyFocused && currentSlot?.sessionId) {
          this.wsServer.broadcastFocusChanged(slotIndex, currentSlot.sessionId);
        }
        this.ctx.emit('peripheral/focus-switched', slotIndex, currentSlot?.sessionId ?? null);
        this.bringWindowToFront();
        return { success: true, focusedSlot: slotIndex };
      },
      onSessionOpened: async (sessionId: string) => {
        const slot = this.router.getSlotBySessionId(sessionId);
        if (slot) {
          let updated = slot;
          if (slot.status === AgentPeripheralStatus.COMPLETED) {
            updated =
              this.router.updateSlot(slot.slotIndex, { status: AgentPeripheralStatus.IDLE }) ?? slot;
          }
          const wasAlreadyFocused = this.router.getFocusedSlot() === slot.slotIndex;
          this.router.switchFocus(slot.slotIndex);
          if (wasAlreadyFocused && updated.sessionId) {
            this.wsServer.broadcastFocusChanged(slot.slotIndex, updated.sessionId);
          }
          this.ctx.emit('peripheral/focus-switched', slot.slotIndex, updated.sessionId ?? null);
          return { success: true, slotIndex: slot.slotIndex };
        }
        return { success: true };
      },
      onSetBrainpower: async (
        slotIndex: number,
        direction?: BrainpowerDirection,
        level?: BrainpowerLevel
      ) => {
        const current = this.router.getSlot(slotIndex);
        if (!current) {
          throw new Error(`Slot ${slotIndex} not found`);
        }
        const newLevel = adjustBrainpower(current.brainpower, direction, level);
        this.router.updateSlot(slotIndex, { brainpower: newLevel });
        this.ctx.emit('peripheral/brainpower-changed', slotIndex, newLevel, current.sessionId ?? null);
        return { success: true, slotIndex, brainpower: newLevel };
      },
      onSelectOption: async (
        slotIndex: number,
        optionIndex: number,
        action: OptionAction
      ) => {
        const slot = this.router.getSlot(slotIndex);
        if (!slot) {
          throw new Error(`Slot ${slotIndex} not found`);
        }
        // 1. Settle pending `approval/request` waterfall in ApprovalArbiter if active
        const settledByArbiter = this.arbiter.resolveBySlotOption(slotIndex, action);

        // 2. Emit DSH interaction resolution event
        this.ctx.emit(
          'peripheral/option-selected',
          slotIndex,
          optionIndex,
          action,
          slot.sessionId ?? null
        );

        // 3. Clear pending question and resume running if not already updated by arbiter cleanup
        if (!settledByArbiter) {
          this.router.updateSlot(slotIndex, {
            status: AgentPeripheralStatus.RUNNING,
            question: undefined,
          });
        }
        return { success: true, slotIndex };
      },
      onAbort: async (slotIndex: number) => {
        const slot = this.router.getSlot(slotIndex);
        if (!slot) {
          throw new Error(`Slot ${slotIndex} not found`);
        }
        // Cancel any pending approval in the arbiter first
        this.arbiter.cancelBySlot(slotIndex);

        this.ctx.emit('peripheral/abort-requested', slotIndex, slot.sessionId ?? null);
        this.router.updateSlot(slotIndex, {
          status: AgentPeripheralStatus.ERROR,
          question: undefined,
        });
        return { success: true, slotIndex };
      },
      onRestart: async () => {
        // Defer restarting slightly to allow JSON-RPC response frame to flush through WebSocket
        setTimeout(() => {
          void this.restart();
        }, 50);
        return { success: true };
      },
      getStatus: () => ({
        isRunning: this.isRunning(),
        isEnabled: this.isEnabled(),
        port: this.wsServer.getPort(),
        totalSlots: this.router.getSnapshot().slots.length,
        clientCount: this.wsServer.getClientCount(),
        hardwareClientCount: this.wsServer.getHardwareClientCount(),
        uiClientCount: this.wsServer.getUiClientCount(),
        transportState: this.transportState,
      }),
    };

    this.wsServer = new PeripheralWsServer({
      host: config?.host ?? DEFAULT_HOST,
      port: config?.port ?? DEFAULT_PORT,
      path: config?.path ?? DEFAULT_PATH,
      handler: rpcHandler,
    });

    this.arbiter = new ApprovalArbiter(this.ctx, this.router, {
      isPeripheralAvailable: () =>
        this.forceArbitration || this.wsServer.getHardwareClientCount() > 0,
      autoBindSlots: this.autoBindSlots,
    });

    // Pipe router changes to WebSocket broadcasts
    this.router.onSlotUpdate((slot: SlotInfo) => {
      this.wsServer.broadcastSlotUpdated(slot);
    });

    this.router.onFocusChange((focusedSlot: number, sessionId: string | null) => {
      if (sessionId) {
        this.wsServer.broadcastFocusChanged(focusedSlot, sessionId);
      }
    });

    this.registerDshEvents();
    this.arbiter.attach();

    // Auto-clean on Cordis fiber disposal (official Cordis lifecycle)
    this.ctx.effect(() => () => {
      try {
        this.localeBinding.dispose();
      } catch {
        // ignore
      }
      return this.stop();
    }, 'peripheral-server:lifecycle');

    // Backward-compatible fallback for synthetic test emits
    this.ctx.on('dispose', async () => {
      await this.stop();
    });

    // Automatically start WebSocket server on initialization if enabled
    if (this.enabled) {
      void this.start();
    }
  }

  private ensureAndUpdateSession(
    sessionId: string,
    patch: Partial<Omit<SlotInfo, 'slotIndex' | 'sessionId'>>
  ): void {
    let slot = this.router.getSlotBySessionId(sessionId);
    if (!slot && this.autoBindSlots) {
      slot = this.router.allocateSlot(sessionId, patch.status ?? AgentPeripheralStatus.IDLE);
    }
    if (slot) {
      this.router.updateSlot(slot.slotIndex, patch);
    }
  }

  /**
   * Subscribes to real DeepSeek Harness (DSH) agent, session, tool, and approval lifecycle events,
   * while preserving backward-compatible event signatures for standalone tests.
   */
  private registerDshEvents(): void {
    // --- A. Real DSH `api-session/*` events (`@deepseek-ai/dsh-api-session-controller`) ---
    this.ctx.on('api-session/added', (summary: DshSessionSummary) => {
      const sessionId = summary.sessionId ?? summary.id;
      if (!sessionId || !this.autoBindSlots) return;
      const isRealDshSummary =
        'formatStatus' in summary || 'blank' in summary || 'agentAvailable' in summary;
      // In real DSH, merely clicking/browsing an old conversation emits `api-session/added` with `running: false`.
      // Only allocate a slot if the session is actually running (preserve standalone test behavior when !isRealDshSummary).
      if (isRealDshSummary && !summary.running) {
        return;
      }
      const initialStatus = summary.running
        ? AgentPeripheralStatus.RUNNING
        : AgentPeripheralStatus.IDLE;
      const existing = this.router.getSlotBySessionId(sessionId);
      if (!existing) {
        const allocated = this.router.allocateSlot(sessionId, initialStatus);
        if (summary.running) {
          this.router.switchFocus(allocated.slotIndex);
        }
      } else if (summary.running) {
        this.router.updateSlot(existing.slotIndex, { status: AgentPeripheralStatus.RUNNING });
        this.router.switchFocus(existing.slotIndex);
      } else if (!isRealDshSummary && summary.running !== undefined) {
        this.router.updateSlot(existing.slotIndex, { status: initialStatus });
      }
    });

    this.ctx.on('api-session/removed', (sessionId: string) => {
      this.router.releaseSession(sessionId);
    });

    this.ctx.on('api-session/status', (sessionId: string, running: boolean) => {
      const current = this.router.getSlotBySessionId(sessionId);
      if (running) {
        // Do not overwrite NEEDS_INPUT while waiting for approval
        if (current?.status === AgentPeripheralStatus.NEEDS_INPUT) {
          return;
        }
        this.ensureAndUpdateSession(sessionId, {
          status: AgentPeripheralStatus.RUNNING,
        });
        const slot = this.router.getSlotBySessionId(sessionId);
        if (slot) {
          this.router.switchFocus(slot.slotIndex);
        }
      } else {
        // Do not allocate a slot when a browsed/inactive session reports running=false,
        // and do not overwrite IDLE status back to COMPLETED once reviewed.
        if (!current || current.status === AgentPeripheralStatus.IDLE) return;
        const nextStatus =
          current.status === AgentPeripheralStatus.ERROR
            ? AgentPeripheralStatus.ERROR
            : AgentPeripheralStatus.COMPLETED;
        this.router.updateSlot(current.slotIndex, {
          status: nextStatus,
          activeTool: undefined,
          question: undefined,
        });
      }
    });

    this.ctx.on('api-session/error', (sessionId: string, _message: string) => {
      this.ensureAndUpdateSession(sessionId, {
        status: AgentPeripheralStatus.ERROR,
        activeTool: undefined,
      });
    });

    // --- B. Real DSH `session/*` events (`@deepseek-ai/dsh-session`) ---
    this.ctx.on('session/created', (session: DshSessionRef | string) => {
      // In real DSH, `session` is an object and `session/created` fires whenever cold history is read
      // or a blank session is pre-warmed. Only allocate immediately for legacy string session IDs in tests.
      if (typeof session !== 'string') return;
      const sessionId = extractSessionId(session);
      if (sessionId && this.autoBindSlots) {
        this.router.allocateSlot(sessionId, AgentPeripheralStatus.IDLE);
      }
    });

    this.ctx.on('session/disposed', (session: DshSessionRef | string) => {
      const sessionId = extractSessionId(session);
      if (sessionId) {
        this.router.releaseSession(sessionId);
      }
    });

    this.ctx.on('session/event', (session: DshSessionRef | string, event: DshSessionEventPayload) => {
      const sessionId = extractSessionId(session);
      if (!sessionId || !event?.type) return;

      switch (event.type) {
        case 'turn/start': {
          this.ensureAndUpdateSession(sessionId, {
            status: AgentPeripheralStatus.RUNNING,
          });
          const slot = this.router.getSlotBySessionId(sessionId);
          if (slot) {
            this.router.switchFocus(slot.slotIndex);
          }
          break;
        }
        case 'turn/end': {
          const reason = typeof event.data?.reason === 'string' ? event.data.reason : undefined;
          const nextStatus =
            reason === 'error' || reason === 'failed'
              ? AgentPeripheralStatus.ERROR
              : AgentPeripheralStatus.COMPLETED;
          this.ensureAndUpdateSession(sessionId, {
            status: nextStatus,
            activeTool: undefined,
            question: undefined,
          });
          break;
        }
        case 'tool/call': {
          const toolName =
            (typeof event.data?.toolName === 'string' ? event.data.toolName : undefined) ??
            (typeof event.data?.name === 'string' ? event.data.name : undefined);
          this.ensureAndUpdateSession(sessionId, {
            status: AgentPeripheralStatus.RUNNING,
            ...(toolName ? { activeTool: toolName } : {}),
          });
          break;
        }
        case 'tool/result':
          this.router.updateSlotBySessionId(sessionId, {
            activeTool: undefined,
          });
          break;
        default:
          break;
      }
    });

    // --- C. Real DSH `agent/*` events (`@deepseek-ai/dsh-agent` + legacy string overload) ---
    this.ctx.on(
      'agent/created',
      (payloadOrId: string | { agent: DshAgentRef; source?: string; signal?: AbortSignal }) => {
        // In real DSH, `agent/created` is emitted with `{ agent, source: 'resume' | 'create' }`
        // whenever a conversation is clicked/viewed in the UI. Only allocate for legacy string IDs in tests.
        if (typeof payloadOrId !== 'string') return;
        if (payloadOrId && this.autoBindSlots) {
          this.router.allocateSlot(payloadOrId, AgentPeripheralStatus.IDLE);
        }
      }
    );

    this.ctx.on(
      'agent/disposed',
      (payloadOrId: string | { agent: DshAgentRef }) => {
        const sessionId =
          typeof payloadOrId === 'string'
            ? payloadOrId
            : extractSessionId(payloadOrId?.agent);
        if (sessionId) {
          this.router.releaseSession(sessionId);
        }
      }
    );

    this.ctx.on(
      'agent/status',
      (
        payloadOrId: string | { agent: DshAgentRef; status: string | AgentPeripheralStatus },
        legacyStatus?: string | AgentPeripheralStatus
      ) => {
        const isLegacyString = typeof payloadOrId === 'string';
        const sessionId = isLegacyString
          ? payloadOrId
          : extractSessionId(payloadOrId?.agent);
        const rawStatus = isLegacyString ? legacyStatus : payloadOrId?.status;
        if (!sessionId || !rawStatus) return;

        const peripheralStatus = this.mapAgentStatus(rawStatus);
        if (!isLegacyString && peripheralStatus === AgentPeripheralStatus.IDLE) {
          const current = this.router.getSlotBySessionId(sessionId);
          if (!current) return;
          if (
            current.status === AgentPeripheralStatus.COMPLETED ||
            current.status === AgentPeripheralStatus.ERROR
          ) {
            return;
          }
        }
        if (!isLegacyString && peripheralStatus === AgentPeripheralStatus.RUNNING) {
          this.ensureAndUpdateSession(sessionId, { status: AgentPeripheralStatus.RUNNING });
          const slot = this.router.getSlotBySessionId(sessionId);
          if (slot) {
            this.router.switchFocus(slot.slotIndex);
          }
          return;
        }
        this.router.updateSlotBySessionId(sessionId, { status: peripheralStatus });
      }
    );

    this.ctx.on(
      'agent/error',
      (
        payloadOrId: string | { agent: DshAgentRef; turn?: number; step?: number; error: unknown },
        _legacyError?: unknown
      ) => {
        const sessionId =
          typeof payloadOrId === 'string'
            ? payloadOrId
            : extractSessionId(payloadOrId?.agent);
        if (!sessionId) return;
        this.ensureAndUpdateSession(sessionId, {
          status: AgentPeripheralStatus.ERROR,
          activeTool: undefined,
        });
      }
    );

    // --- D. Real DSH `tools/*` events (`@deepseek-ai/dsh-tools`) ---
    this.ctx.on(
      'tools/pre-execute',
      async (exec: DshToolExecutionPayload, next: () => Promise<unknown>) => {
        const sessionId = extractSessionId(exec?.agent);
        const toolName = exec?.name ?? exec?.toolName;
        if (sessionId && toolName) {
          this.ensureAndUpdateSession(sessionId, {
            status: AgentPeripheralStatus.RUNNING,
            activeTool: toolName,
          });
        }
        return await next();
      }
    );

    this.ctx.on('tools/result', (exec: DshToolExecutionPayload) => {
      const sessionId = extractSessionId(exec?.agent);
      if (sessionId) {
        this.router.updateSlotBySessionId(sessionId, {
          activeTool: undefined,
        });
      }
    });

    // --- E. Human-In-The-Loop interactive prompt & legacy tool helpers ---
    this.ctx.on(
      'interaction/user-questions',
      (sessionId: string, question: { prompt: string; options: string[] }) => {
        this.router.updateSlotBySessionId(sessionId, {
          status: AgentPeripheralStatus.NEEDS_INPUT,
          question,
        });
      }
    );

    this.ctx.on('agent/tool-start', (sessionId: string, toolName: string) => {
      this.router.updateSlotBySessionId(sessionId, {
        status: AgentPeripheralStatus.RUNNING,
        activeTool: toolName,
      });
    });

    this.ctx.on('agent/tool-end', (sessionId: string) => {
      this.router.updateSlotBySessionId(sessionId, {
        activeTool: undefined,
      });
    });
  }

  private mapAgentStatus(status: string | AgentPeripheralStatus): AgentPeripheralStatus {
    if (Object.values(AgentPeripheralStatus).includes(status as AgentPeripheralStatus)) {
      return status as AgentPeripheralStatus;
    }

    switch (status.toLowerCase()) {
      case 'idle':
        return AgentPeripheralStatus.IDLE;
      case 'running':
      case 'executing':
      case 'busy':
        return AgentPeripheralStatus.RUNNING;
      case 'needs_input':
      case 'awaiting_approval':
      case 'paused':
        return AgentPeripheralStatus.NEEDS_INPUT;
      case 'completed':
      case 'success':
      case 'done':
        return AgentPeripheralStatus.COMPLETED;
      case 'error':
      case 'failed':
      case 'blocked':
        return AgentPeripheralStatus.ERROR;
      default:
        return AgentPeripheralStatus.IDLE;
    }
  }

  /**
   * Returns the latest hardware transport mode and capabilities reported by the daemon.
   */
  public getTransportState(): TransportChangedParams {
    return this.transportState;
  }

  /**
   * Activates the DeepSeek Harness macOS desktop application window.
   */
  public bringWindowToFront(): void {
    if (typeof process !== 'undefined' && process.platform === 'darwin') {
      import('node:child_process')
        .then(({ execFile }) => {
          execFile('/usr/bin/osascript', ['-e', 'tell application "DeepSeek Harness" to activate'], () => {});
        })
        .catch(() => {});
    }
  }

  /**
   * Returns whether the peripheral service is enabled.
   */
  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Returns whether the peripheral service is actively running and serving WebSocket clients.
   */
  public isRunning(): boolean {
    return this.isStarted && this.wsServer.isRunning();
  }

  /**
   * Hot-start: open/enable the peripheral server and daemon without restarting DeepSeek Harness.
   */
  public async open(): Promise<void> {
    this.enabled = true;
    await this.start();
  }

  /**
   * Hot-stop: close/disable the peripheral server and daemon without restarting DeepSeek Harness.
   */
  public async close(): Promise<void> {
    this.enabled = false;
    await this.stop();
  }

  /**
   * Hot-restart: completely stop and restart the peripheral bridge and daemon.
   */
  public async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  /**
   * Discovers and synchronizes existing live sessions from DeepSeek Harness runtime context.
   * Ensures seamless hot-start state hydration without requiring conversation re-triggering.
   */
  public hydrateExistingSessions(): void {
    if (!this.autoBindSlots) return;

    try {
      const getContextService = (key: string): any => {
        try {
          const fromGet =
            typeof (this.ctx as any).get === 'function'
              ? (this.ctx as any).get(key)
              : undefined;
          return fromGet ?? (this.ctx as any)[key];
        } catch {
          try {
            return (this.ctx as any)[key];
          } catch {
            return undefined;
          }
        }
      };

      // 1. Query @deepseek-ai/dsh-session store if accessible
      const sessionsStore = getContextService('sessions');
      if (sessionsStore && typeof sessionsStore.list === 'function') {
        const liveSessions = sessionsStore.list();
        if (Array.isArray(liveSessions)) {
          for (const session of liveSessions) {
            const sessionId = typeof session === 'string' ? session : session?.id;
            if (sessionId && !this.router.getSlotBySessionId(sessionId)) {
              this.router.allocateSlot(sessionId, AgentPeripheralStatus.IDLE);
            }
          }
        }
      }

      // 2. Query @deepseek-ai/dsh-agent registry if accessible
      const agentsRegistry = getContextService('agents');
      if (agentsRegistry && typeof agentsRegistry.list === 'function') {
        const liveAgents = agentsRegistry.list();
        if (Array.isArray(liveAgents)) {
          for (const agent of liveAgents) {
            const sessionId =
              typeof agent === 'string' ? agent : (agent?.session?.id ?? agent?.id);
            if (!sessionId) continue;
            let slot = this.router.getSlotBySessionId(sessionId);
            if (!slot) {
              slot = this.router.allocateSlot(sessionId, AgentPeripheralStatus.IDLE);
            }
          }
        }
      }

      // 3. Query api-session controller if accessible
      const sessionController = getContextService('sessionController');
      if (sessionController?.listState && typeof sessionController.listState.list === 'function') {
        Promise.resolve(sessionController.listState.list())
          .then((summaries: any[]) => {
            if (Array.isArray(summaries)) {
              for (const summary of summaries) {
                const sessionId = summary?.sessionId ?? summary?.id;
                if (!sessionId) continue;
                const isRunning = Boolean(summary.running);
                let slot = this.router.getSlotBySessionId(sessionId);
                if (
                  !slot &&
                  (isRunning ||
                    this.router
                      .getSnapshot()
                      .slots.filter((s) => s.status !== AgentPeripheralStatus.INACTIVE).length < 3)
                ) {
                  slot = this.router.allocateSlot(
                    sessionId,
                    isRunning ? AgentPeripheralStatus.RUNNING : AgentPeripheralStatus.IDLE
                  );
                }
                if (slot && isRunning) {
                  this.router.updateSlot(slot.slotIndex, { status: AgentPeripheralStatus.RUNNING });
                  this.router.switchFocus(slot.slotIndex);
                }
              }
            }
          })
          .catch(() => {});
      }
    } catch {
      // Hot-start hydration is best-effort and must not throw
    }
  }

  /**
   * Starts the peripheral server and optionally the hardware daemon process.
   */
  public async start(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    if (this.stopPromise) {
      await this.stopPromise;
    }
    if (this.isStarted && this.wsServer.isRunning()) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.doStart();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async doStart(): Promise<void> {
    await this.wsServer.start();
    if (this.autoStartDaemon) {
      void this.daemonManager.start();
    }
    this.hydrateExistingSessions();
    this.isStarted = true;
    this.ctx.emit('peripheral/started');
  }

  protected async [Service.init](): Promise<void> {
    if (this.enabled) {
      await this.start();
    }
  }

  /**
   * Stops the peripheral server and terminates active client connections and daemon process.
   */
  public async stop(): Promise<void> {
    if (this.startPromise) {
      await this.startPromise;
    }
    if (this.stopPromise) {
      return this.stopPromise;
    }
    if (!this.isStarted && !this.wsServer.isRunning() && !this.daemonManager.isRunning()) {
      return;
    }
    this.stopPromise = this.doStop();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }

  private async doStop(): Promise<void> {
    this.isStarted = false;
    try {
      this.arbiter.dispose();
    } catch {
      // ignore
    }
    await Promise.allSettled([
      this.daemonManager.stop(),
      this.wsServer.close(),
    ]);
    this.ctx.emit('peripheral/stopped');
  }
}

export function apply(ctx: Context, config?: PeripheralServerConfig): void {
  ctx.plugin(PeripheralServerService, config);
}

declare module 'cordis' {
  interface Context {
    peripheralServer: PeripheralServerService;
  }

  interface Events {
    'dispose'(): void | Promise<void>;
    'api-session/added'(summary: DshSessionSummary): void;
    'api-session/removed'(sessionId: string): void;
    'api-session/status'(sessionId: string, running: boolean): void;
    'api-session/error'(sessionId: string, message: string): void;
    'session/created'(session: DshSessionRef | string): void;
    'session/disposed'(session: DshSessionRef | string): void;
    'session/event'(session: DshSessionRef | string, event: DshSessionEventPayload): void;
    'agent/created'(payloadOrId: string | { agent: DshAgentRef; source?: string; signal?: AbortSignal }): void | Promise<void>;
    'agent/disposed'(payloadOrId: string | { agent: DshAgentRef }): void;
    'agent/status'(
      payloadOrId: string | { agent: DshAgentRef; status: string | AgentPeripheralStatus },
      legacyStatus?: string | AgentPeripheralStatus
    ): void;
    'agent/error'(
      payloadOrId: string | { agent: DshAgentRef; turn?: number; step?: number; error: unknown },
      legacyError?: unknown
    ): void;
    'tools/pre-execute'(exec: DshToolExecutionPayload, next: () => Promise<unknown>): Promise<unknown>;
    'tools/result'(exec: DshToolExecutionPayload, result?: unknown): void;
    'approval/request'(
      req: ApprovalRequestEvent,
      next: () => Promise<ApprovalOutcome>
    ): Promise<ApprovalOutcome>;
    'interaction/user-questions'(sessionId: string, question: { prompt: string; options: string[] }): void;
    'agent/tool-start'(sessionId: string, toolName: string): void;
    'agent/tool-end'(sessionId: string): void;
    'peripheral/focus-switched'(slotIndex: number, sessionId: string | null): void;
    'peripheral/brainpower-changed'(slotIndex: number, level: BrainpowerLevel, sessionId: string | null): void;
    'peripheral/option-selected'(slotIndex: number, optionIndex: number, action: OptionAction, sessionId: string | null): void;
    'peripheral/abort-requested'(slotIndex: number, sessionId: string | null): void;
    'peripheral/transport-changed'(params: TransportChangedParams): void;
    'peripheral/started'(): void;
    'peripheral/stopped'(): void;
  }
}
