import { Context, Service } from 'cordis';
import {
  AgentPeripheralStatus,
  type BrainpowerLevel,
  type BrainpowerDirection,
  type OptionAction,
  type SlotInfo,
  DEFAULT_PORT,
  DEFAULT_HOST,
  DEFAULT_PATH,
} from '@dsh-hid/protocol';
import { SessionRouter } from './router.js';
import { PeripheralWsServer, type PeripheralRpcHandler } from './ws-server.js';

export interface PeripheralServerConfig {
  host?: string;
  port?: number;
  path?: string;
  totalSlots?: number;
  autoBindSlots?: boolean;
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
    return BRAINPOWER_LEVELS[nextIndex];
  } else if (direction === 'stepDown') {
    const prevIndex = Math.max(0, currentIndex - 1);
    return BRAINPOWER_LEVELS[prevIndex];
  }

  return current;
}

export class PeripheralServerService extends Service {
  public static readonly inject = {
    optional: ['agentLoop', 'session', 'interaction'],
  };

  public readonly router: SessionRouter;
  public readonly wsServer: PeripheralWsServer;
  private readonly autoBindSlots: boolean;

  constructor(ctx: Context, config?: PeripheralServerConfig) {
    super(ctx, 'peripheralServer');

    this.autoBindSlots = config?.autoBindSlots ?? true;
    this.router = new SessionRouter({ totalSlots: config?.totalSlots });

    const rpcHandler: PeripheralRpcHandler = {
      getInitialSnapshot: () => this.router.getSnapshot(),
      onSwitchFocus: async (slotIndex: number) => {
        const ok = this.router.switchFocus(slotIndex);
        if (!ok) {
          throw new Error(`Failed to switch focus: invalid slot ${slotIndex}`);
        }
        const currentSlot = this.router.getSlot(slotIndex);
        this.ctx.emit('peripheral/focus-switched', slotIndex, currentSlot?.sessionId ?? null);
        return { success: true, focusedSlot: slotIndex };
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
        // Emit DSH interaction resolution event
        this.ctx.emit(
          'peripheral/option-selected',
          slotIndex,
          optionIndex,
          action,
          slot.sessionId ?? null
        );
        // Clear pending question and resume running
        this.router.updateSlot(slotIndex, {
          status: AgentPeripheralStatus.RUNNING,
          question: undefined,
        });
        return { success: true, slotIndex };
      },
      onAbort: async (slotIndex: number) => {
        const slot = this.router.getSlot(slotIndex);
        if (!slot) {
          throw new Error(`Slot ${slotIndex} not found`);
        }
        this.ctx.emit('peripheral/abort-requested', slotIndex, slot.sessionId ?? null);
        this.router.updateSlot(slotIndex, {
          status: AgentPeripheralStatus.ERROR,
        });
        return { success: true, slotIndex };
      },
    };

    this.wsServer = new PeripheralWsServer({
      host: config?.host ?? DEFAULT_HOST,
      port: config?.port ?? DEFAULT_PORT,
      path: config?.path ?? DEFAULT_PATH,
      handler: rpcHandler,
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

    // Auto-clean on context dispose
    this.ctx.on('dispose', async () => {
      await this.stop();
    });
  }

  /**
   * Subscribes to DSH agent lifecycle and interaction events.
   */
  private registerDshEvents(): void {
    // 1. Agent instance created
    this.ctx.on('agent/created', (sessionId: string) => {
      if (this.autoBindSlots) {
        this.router.allocateSlot(sessionId, AgentPeripheralStatus.IDLE);
      }
    });

    // 2. Agent instance disposed / closed
    this.ctx.on('agent/disposed', (sessionId: string) => {
      this.router.releaseSession(sessionId);
    });

    // 3. Agent status transitions (e.g. idle, running, error, completed)
    this.ctx.on('agent/status', (sessionId: string, status: string | AgentPeripheralStatus) => {
      const peripheralStatus = this.mapAgentStatus(status);
      this.router.updateSlotBySessionId(sessionId, { status: peripheralStatus });
    });

    // 4. Human-In-The-Loop interactive prompt
    this.ctx.on(
      'interaction/user-questions',
      (sessionId: string, question: { prompt: string; options: string[] }) => {
        this.router.updateSlotBySessionId(sessionId, {
          status: AgentPeripheralStatus.NEEDS_INPUT,
          question,
        });
      }
    );

    // 5. Active tool execution tracking
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
   * Starts the peripheral server.
   */
  public async start(): Promise<void> {
    await this.wsServer.start();
  }

  /**
   * Stops the peripheral server and terminates active client connections.
   */
  public async stop(): Promise<void> {
    await this.wsServer.close();
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
    'agent/created'(sessionId: string): void;
    'agent/disposed'(sessionId: string): void;
    'agent/status'(sessionId: string, status: string | AgentPeripheralStatus): void;
    'interaction/user-questions'(sessionId: string, question: { prompt: string; options: string[] }): void;
    'agent/tool-start'(sessionId: string, toolName: string): void;
    'agent/tool-end'(sessionId: string): void;
    'peripheral/focus-switched'(slotIndex: number, sessionId: string | null): void;
    'peripheral/brainpower-changed'(slotIndex: number, level: BrainpowerLevel, sessionId: string | null): void;
    'peripheral/option-selected'(slotIndex: number, optionIndex: number, action: OptionAction, sessionId: string | null): void;
    'peripheral/abort-requested'(slotIndex: number, sessionId: string | null): void;
  }
}
