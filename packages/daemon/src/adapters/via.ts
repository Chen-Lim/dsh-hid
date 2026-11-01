import {
  VIA_RAW_HID_REPORT_LENGTH,
  VIA_RAW_HID_MAGIC,
  buildViaSetAllSlotsReport,
  parseViaUplinkReport,
  type SlotInfo,
} from '@dsh-hid/protocol';
import type { HardwareAdapter, HardwareEvent, HardwareEventListener } from './types.js';

/**
 * Low-level bidirectional transport for 32-byte VIA Raw HID frames.
 */
export interface ViaReportTransport {
  send(report: Uint8Array): Promise<void>;
  onReport(listener: (report: Uint8Array) => void): () => void;
  close?(): Promise<void>;
}

export interface ViaAdapterOptions {
  transport?: ViaReportTransport;
}

/**
 * VIA / QMK Raw HID adapter implementing 32-byte bidirectional frame communication.
 * Downlink: Sets LED status for F1-F12 slots and active focus.
 * Uplink: Listens for key switch focus, rotary knob events, and rapid confirmation actions.
 */
export class ViaRawhidAdapter implements HardwareAdapter {
  readonly name = 'via-rawhid';

  private readonly transport: ViaReportTransport | null;
  private readonly listeners = new Set<HardwareEventListener>();
  private connected = false;
  private unregisterTransportListener: (() => void) | null = null;

  constructor(options: ViaAdapterOptions = {}) {
    this.transport = options.transport ?? null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;

    if (this.transport) {
      this.unregisterTransportListener = this.transport.onReport((report) => {
        this.handleIncomingReport(report);
      });
    }
  }

  async disconnect(): Promise<void> {
    if (this.unregisterTransportListener) {
      this.unregisterTransportListener();
      this.unregisterTransportListener = null;
    }

    if (this.transport?.close) {
      await this.transport.close();
    }

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
   * Send 32-byte report to QMK/VIA matrix to update all slot LEDs and focus indicator.
   */
  async renderSlots(slots: SlotInfo[], focusedSlot: number): Promise<void> {
    if (!this.connected || !this.transport) {
      return;
    }

    const report = buildViaSetAllSlotsReport(focusedSlot, slots);
    await this.transport.send(report);
  }

  /**
   * Handle incoming 32-byte raw HID report and dispatch parsed hardware events.
   */
  handleIncomingReport(report: Uint8Array): void {
    if (report.length !== VIA_RAW_HID_REPORT_LENGTH || report[0] !== VIA_RAW_HID_MAGIC) {
      return;
    }

    const event = parseViaUplinkReport(report);
    if (!event) return;

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error('[ViaRawhidAdapter] Listener error:', err);
      }
    }
  }
}
