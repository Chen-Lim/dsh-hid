import { describe, it, expect, vi } from 'vitest';
import {
  AgentPeripheralStatus,
  VIA_RAW_HID_MAGIC,
  VIA_RAW_HID_REPORT_LENGTH,
  VIA_CMD_SET_ALL_SLOTS,
  STATUS_TO_BYTE_MAP,
  type SlotInfo,
} from '@dsh-hid/protocol';
import { ViaRawhidAdapter, type ViaReportTransport } from '../src/index.js';

class MockViaTransport implements ViaReportTransport {
  sentReports: Uint8Array[] = [];
  private reportListeners = new Set<(report: Uint8Array) => void>();

  async send(report: Uint8Array): Promise<void> {
    this.sentReports.push(new Uint8Array(report));
  }

  onReport(listener: (report: Uint8Array) => void): () => void {
    this.reportListeners.add(listener);
    return () => {
      this.reportListeners.delete(listener);
    };
  }

  emitReport(report: Uint8Array): void {
    for (const listener of this.reportListeners) {
      listener(report);
    }
  }
}

describe('ViaRawhidAdapter', () => {
  it('connects and renders 32-byte slot matrix report to transport', async () => {
    const transport = new MockViaTransport();
    const adapter = new ViaRawhidAdapter({ transport });

    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);

    const slots: SlotInfo[] = [
      { slotIndex: 1, status: AgentPeripheralStatus.IDLE },
      { slotIndex: 2, status: AgentPeripheralStatus.RUNNING },
      { slotIndex: 3, status: AgentPeripheralStatus.NEEDS_INPUT },
    ];

    await adapter.renderSlots(slots, 2);

    expect(transport.sentReports).toHaveLength(1);
    const report = transport.sentReports[0];
    expect(report).toHaveLength(VIA_RAW_HID_REPORT_LENGTH);
    expect(report[0]).toBe(VIA_RAW_HID_MAGIC);
    expect(report[1]).toBe(VIA_CMD_SET_ALL_SLOTS);
    expect(report[2]).toBe(2); // focusedSlot
    expect(report[3]).toBe(STATUS_TO_BYTE_MAP[AgentPeripheralStatus.IDLE]); // slot 1
    expect(report[4]).toBe(STATUS_TO_BYTE_MAP[AgentPeripheralStatus.RUNNING]); // slot 2
    expect(report[5]).toBe(STATUS_TO_BYTE_MAP[AgentPeripheralStatus.NEEDS_INPUT]); // slot 3
  });

  it('receives uplink 32-byte frames and dispatches typed hardware events', async () => {
    const transport = new MockViaTransport();
    const adapter = new ViaRawhidAdapter({ transport });
    await adapter.connect();

    const listener = vi.fn();
    adapter.onEvent(listener);

    // 1. Simulate keypress F4 (0x10, slot 4)
    const f4Frame = new Uint8Array(32);
    f4Frame[0] = VIA_RAW_HID_MAGIC;
    f4Frame[1] = 0x10;
    f4Frame[2] = 4;
    transport.emitReport(f4Frame);
    expect(listener).toHaveBeenCalledWith({ type: 'switchFocus', slotIndex: 4 });

    // 2. Simulate knob rotate clockwise (0x11, 0x01)
    const knobFrame = new Uint8Array(32);
    knobFrame[0] = VIA_RAW_HID_MAGIC;
    knobFrame[1] = 0x11;
    knobFrame[2] = 0x01;
    transport.emitReport(knobFrame);
    expect(listener).toHaveBeenCalledWith({ type: 'knob', action: 'stepUp' });

    // 3. Simulate option confirm ACCEPT (0x12, 0x00)
    const optionFrame = new Uint8Array(32);
    optionFrame[0] = VIA_RAW_HID_MAGIC;
    optionFrame[1] = 0x12;
    optionFrame[2] = 0x00;
    transport.emitReport(optionFrame);
    expect(listener).toHaveBeenCalledWith({ type: 'option', action: 'ACCEPT' });

    expect(listener).toHaveBeenCalledTimes(3);

    await adapter.disconnect();
    expect(adapter.isConnected()).toBe(false);
  });
});
