import {
  AgentPeripheralStatus,
  type SlotInfo,
  type BrainpowerDirection,
  type OptionAction,
} from '@dsh-hid/protocol';
import type { HardwareAdapter, HardwareEvent, HardwareEventListener } from './types.js';

/**
 * ANSI Color Escape Codes for terminal rendering.
 */
const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgYellow: '\x1b[43m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgDark: '\x1b[100m',
};

export interface MockAdapterOptions {
  /** If true, prints to console stdout on every renderSlots call */
  interactiveOutput?: boolean;
}

/**
 * Mock simulator adapter displaying F1-F12 key LEDs, focus, and state in ANSI color format.
 */
export class MockAdapter implements HardwareAdapter {
  readonly name = 'mock';

  private connected = false;
  private readonly listeners = new Set<HardwareEventListener>();
  private readonly interactiveOutput: boolean;

  private currentSlots: SlotInfo[] = [];
  private currentFocusedSlot = 1;
  private lastRenderedString = '';

  constructor(options: MockAdapterOptions = {}) {
    this.interactiveOutput = options.interactiveOutput ?? false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getLastRenderedString(): string {
    return this.lastRenderedString;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.listeners.clear();
  }

  onEvent(listener: HardwareEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Dispatch a simulated hardware event to registered listeners.
   */
  emitHardwareEvent(event: HardwareEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        // Safe dispatch without crashing
        console.error('[MockAdapter] Listener error:', err);
      }
    }
  }

  simulateKeyPress(slotIndex: number): void {
    this.emitHardwareEvent({ type: 'switchFocus', slotIndex });
  }

  simulateKnob(action: BrainpowerDirection | 'press'): void {
    this.emitHardwareEvent({ type: 'knob', action });
  }

  simulateOption(action: OptionAction): void {
    this.emitHardwareEvent({ type: 'option', action });
  }

  simulateAbort(): void {
    this.emitHardwareEvent({ type: 'abort' });
  }

  async renderSlots(slots: SlotInfo[], focusedSlot: number): Promise<void> {
    this.currentSlots = [...slots];
    this.currentFocusedSlot = focusedSlot;
    const output = this.renderToString(slots, focusedSlot);
    this.lastRenderedString = output;

    if (this.interactiveOutput) {
      // Clear screen or print block
      process.stdout.write(`\n${output}\n`);
    }
  }

  /**
   * Render the 12-key status grid and control info into formatted string (with ANSI formatting).
   */
  renderToString(slots: SlotInfo[], focusedSlot: number): string {
    const slotMap = new Map<number, SlotInfo>();
    for (const slot of slots) {
      slotMap.set(slot.slotIndex, slot);
    }

    const lines: string[] = [];
    lines.push('╔══════════════════════════════════════════════════════════════════════════╗');
    lines.push('║             DSH HID Peripheral Hardware Simulator (MockAdapter)          ║');
    lines.push('╠══════════════════════════════════════════════════════════════════════════╣');

    // Row 1: F1 - F6
    const row1 = this.renderKeyRow([1, 2, 3, 4, 5, 6], slotMap, focusedSlot);
    lines.push(`║  ${row1}  ║`);

    // Row 2: F7 - F12
    const row2 = this.renderKeyRow([7, 8, 9, 10, 11, 12], slotMap, focusedSlot);
    lines.push(`║  ${row2}  ║`);

    lines.push('╠══════════════════════════════════════════════════════════════════════════╣');

    const focusedInfo = slotMap.get(focusedSlot);
    const statusText = focusedInfo ? focusedInfo.status : AgentPeripheralStatus.INACTIVE;
    const brainpowerText = focusedInfo?.brainpower ?? 'standard';
    const toolText = focusedInfo?.activeTool ? ` [Tool: ${focusedInfo.activeTool}]` : '';

    lines.push(
      `║ Focus: Slot F${focusedSlot} (${statusText})${toolText.padEnd(25)} Brainpower: ${brainpowerText.padEnd(8)} ║`,
    );

    if (focusedInfo?.question) {
      lines.push('╠──────────────────────────────────────────────────────────────────────────╢');
      const qPrompt = `║ ? [F${focusedSlot}] Question: ${focusedInfo.question.prompt}`;
      lines.push(qPrompt.padEnd(75) + '║');
      const opts = `║   Options: ${focusedInfo.question.options.join(' | ')}`;
      lines.push(opts.padEnd(75) + '║');
    } else {
      // Check if any slot is waiting for input
      const waitingSlot = slots.find((s) => s.question);
      if (waitingSlot?.question) {
        lines.push('╠──────────────────────────────────────────────────────────────────────────╢');
        const qPrompt = `║ ? [F${waitingSlot.slotIndex}] Question: ${waitingSlot.question.prompt}`;
        lines.push(qPrompt.padEnd(75) + '║');
        const opts = `║   Options: ${waitingSlot.question.options.join(' | ')}`;
        lines.push(opts.padEnd(75) + '║');
      }
    }

    lines.push('╚══════════════════════════════════════════════════════════════════════════╝');
    return lines.join('\n');
  }

  private renderKeyRow(
    indexes: number[],
    slotMap: Map<number, SlotInfo>,
    focusedSlot: number,
  ): string {
    return indexes
      .map((idx) => {
        const info = slotMap.get(idx);
        const status = info?.status ?? AgentPeripheralStatus.INACTIVE;
        const isFocused = idx === focusedSlot;
        const color = this.getStatusColor(status);
        const prefix = isFocused ? `${ANSI.bold}►` : ' ';
        const keyLabel = `F${idx}:${this.shortStatus(status)}`;
        return `${color}${prefix}[${keyLabel}]${ANSI.reset}`;
      })
      .join(' ');
  }

  private shortStatus(status: AgentPeripheralStatus): string {
    switch (status) {
      case AgentPeripheralStatus.INACTIVE:
        return 'OFF';
      case AgentPeripheralStatus.IDLE:
        return 'IDL';
      case AgentPeripheralStatus.RUNNING:
        return 'RUN';
      case AgentPeripheralStatus.NEEDS_INPUT:
        return 'ASK';
      case AgentPeripheralStatus.COMPLETED:
        return 'DON';
      case AgentPeripheralStatus.ERROR:
        return 'ERR';
    }
  }

  private getStatusColor(status: AgentPeripheralStatus): string {
    switch (status) {
      case AgentPeripheralStatus.INACTIVE:
        return ANSI.dim + ANSI.white;
      case AgentPeripheralStatus.IDLE:
        return ANSI.white;
      case AgentPeripheralStatus.RUNNING:
        return ANSI.cyan;
      case AgentPeripheralStatus.NEEDS_INPUT:
        return ANSI.yellow;
      case AgentPeripheralStatus.COMPLETED:
        return ANSI.green;
      case AgentPeripheralStatus.ERROR:
        return ANSI.red;
    }
  }
}
