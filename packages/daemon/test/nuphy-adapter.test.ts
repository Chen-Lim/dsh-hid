import { describe, it, expect, vi } from 'vitest';
import {
  AgentPeripheralStatus,
  NUPHY_CMD_TEMP_SESSION,
  NUPHY_CMD_SET_DATA,
  NUPHY_HEADER_DEVICE,
  NUPHY_REG_MAIN_BACKLIGHT,
  NUPHY_REG_BRIGHTNESS,
  nuphyChecksum,
  type SlotInfo,
} from '@dsh-hid/protocol';
import { NuphyV3Adapter, type NuphyReportTransport } from '../src/index.js';

class MockNuphyTransport implements NuphyReportTransport {
  sentReports: Uint8Array[] = [];
  mockSessionKey = 0x6b;

  async send(report: Uint8Array): Promise<void> {
    this.sentReports.push(new Uint8Array(report));
  }

  async receive(_timeoutMs: number): Promise<Uint8Array | null> {
    const lastSent = this.sentReports[this.sentReports.length - 1];
    if (!lastSent) return null;

    const command = lastSent[1];
    if (command === NUPHY_CMD_TEMP_SESSION) {
      // Build mock session response
      const resp = new Uint8Array(64);
      resp[0] = NUPHY_HEADER_DEVICE;
      resp[1] = NUPHY_CMD_TEMP_SESSION;
      resp[4] = this.mockSessionKey;
      resp[5] = this.mockSessionKey;
      resp[6] = this.mockSessionKey;
      resp[7] = this.mockSessionKey;
      for (let i = 0; i < 56; i++) {
        resp[8 + i] = lastSent[8 + i] ^ this.mockSessionKey;
      }
      resp[3] = nuphyChecksum(resp);
      return resp;
    }

    if (command === NUPHY_CMD_SET_DATA) {
      const resp = new Uint8Array(64);
      resp[0] = NUPHY_HEADER_DEVICE;
      resp[1] = NUPHY_CMD_SET_DATA;
      // Echo length, address, handle = 0
      resp[4] = lastSent[4];
      resp[5] = lastSent[5];
      resp[6] = lastSent[6];
      resp[7] = 0 ^ this.mockSessionKey;
      resp[3] = nuphyChecksum(resp);
      return resp;
    }

    return null;
  }
}

describe('NuphyV3Adapter', () => {
  it('connects via mock transport with dynamic SessionKey handshake', async () => {
    const transport = new MockNuphyTransport();
    const adapter = new NuphyV3Adapter({ transport });

    expect(adapter.isConnected()).toBe(false);
    expect(adapter.getSessionKey()).toBeNull();

    await adapter.connect();

    expect(adapter.isConnected()).toBe(true);
    expect(adapter.getSessionKey()).toBe(0x6b);
    expect(transport.sentReports.length).toBe(1);
    expect(transport.sentReports[0][1]).toBe(NUPHY_CMD_TEMP_SESSION);
  });

  it('renders status changes to main backlight and brightness registers', async () => {
    const transport = new MockNuphyTransport();
    const adapter = new NuphyV3Adapter({ transport });
    await adapter.connect();

    const slots: SlotInfo[] = [
      { slotIndex: 1, status: AgentPeripheralStatus.IDLE },
      { slotIndex: 2, status: AgentPeripheralStatus.RUNNING },
    ];

    // Focus on Slot 2 (RUNNING -> BLUE_EXECUTION)
    await adapter.renderSlots(slots, 2);

    expect(adapter.getCurrentStatus()).toBe(AgentPeripheralStatus.RUNNING);
    // Should have sent main backlight write + brightness write
    expect(transport.sentReports.length).toBe(3); // 1 handshake + 2 writes

    const mainWrite = transport.sentReports[1];
    expect(mainWrite[1]).toBe(NUPHY_CMD_SET_DATA);
    // Address 0 check with XOR key
    const decodedAddr = (mainWrite[5] ^ 0x6b) | ((mainWrite[6] ^ 0x6b) << 8);
    expect(decodedAddr).toBe(NUPHY_REG_MAIN_BACKLIGHT);

    const brightWrite = transport.sentReports[2];
    const decodedBrightAddr = (brightWrite[5] ^ 0x6b) | ((brightWrite[6] ^ 0x6b) << 8);
    expect(decodedBrightAddr).toBe(NUPHY_REG_BRIGHTNESS);
  });

  it('turns off signal LEDs when disconnecting', async () => {
    const transport = new MockNuphyTransport();
    const adapter = new NuphyV3Adapter({ transport });
    await adapter.connect();

    const countBefore = transport.sentReports.length;
    await adapter.disconnect();

    expect(adapter.isConnected()).toBe(false);
    expect(transport.sentReports.length).toBeGreaterThan(countBefore);
  });
});
