import {
  AgentPeripheralStatus,
  NUPHY_VENDOR_ID,
  AIR65_V3_PRODUCT_ID,
  NUPHY_PAYLOAD_LENGTH,
  NUPHY_REG_MAIN_BACKLIGHT,
  NUPHY_REG_BRIGHTNESS,
  NUPHY_PRESET_BLUE_EXECUTION,
  NUPHY_PRESET_ORANGE_ATTENTION,
  NUPHY_PRESET_GREEN_COMPLETION,
  NUPHY_PRESET_RED_ERROR,
  NUPHY_PRESET_SIGNAL_OFF,
  buildNuphySessionRequest,
  validateNuphySessionResponse,
  buildNuphyWriteRequest,
  validateNuphyResponse,
  NUPHY_CMD_SET_DATA,
  type SlotInfo,
} from '@dsh-hid/protocol';
import type { HardwareAdapter, HardwareEventListener } from './types.js';

/**
 * Low-level bidirectional HID report transport interface.
 */
export interface NuphyReportTransport {
  send(report: Uint8Array): Promise<void>;
  receive(timeoutMs: number): Promise<Uint8Array | null>;
  close?(): Promise<void>;
}

export interface NuphyAdapterOptions {
  transport?: NuphyReportTransport;
}

/**
 * Nuphy Air V3 hardware adapter ported from Keyphore reverse engineering.
 * Features 64-byte framing, SessionKey XOR dynamic handshake, and backlight state writing.
 */
export class NuphyV3Adapter implements HardwareAdapter {
  readonly name = 'nuphy-air-v3';

  private readonly transport: NuphyReportTransport | null;
  private readonly listeners = new Set<HardwareEventListener>();
  private connected = false;
  private sessionKey: number | null = null;
  private currentStatus: AgentPeripheralStatus = AgentPeripheralStatus.INACTIVE;

  constructor(options: NuphyAdapterOptions = {}) {
    this.transport = options.transport ?? null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  getSessionKey(): number | null {
    return this.sessionKey;
  }

  getCurrentStatus(): AgentPeripheralStatus {
    return this.currentStatus;
  }

  async connect(): Promise<void> {
    if (!this.transport) {
      // In offline/mock mode when no transport is provided
      this.connected = true;
      this.sessionKey = 0x5a;
      return;
    }

    // Perform Keyphore challenge-response handshake to obtain dynamic SessionKey
    const challenge = new Uint8Array(NUPHY_PAYLOAD_LENGTH);
    for (let i = 0; i < challenge.length; i++) {
      challenge[i] = Math.floor(Math.random() * 256);
    }

    const sessionReq = buildNuphySessionRequest(challenge);
    await this.transport.send(sessionReq);

    const response = await this.transport.receive(1500);
    if (!response) {
      throw new Error('Nuphy handshake timeout: no response received from device');
    }

    this.sessionKey = validateNuphySessionResponse(response, challenge);
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    if (this.connected && this.transport && this.sessionKey !== null) {
      // Turn off signals before disconnecting
      try {
        await this.writeBacklight(NUPHY_PRESET_SIGNAL_OFF);
      } catch {
        // Suppress teardown errors
      }
    }

    if (this.transport?.close) {
      await this.transport.close();
    }

    this.connected = false;
    this.sessionKey = null;
    this.listeners.clear();
  }

  onEvent(listener: HardwareEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Synchronize slot states and focus indicator to the Nuphy keyboard backlight.
   */
  async renderSlots(slots: SlotInfo[], focusedSlot: number): Promise<void> {
    const focusedInfo = slots.find((s) => s.slotIndex === focusedSlot);
    const targetStatus = focusedInfo?.status ?? AgentPeripheralStatus.INACTIVE;
    this.currentStatus = targetStatus;

    if (!this.transport || this.sessionKey === null) {
      return;
    }

    const payload = this.getBacklightPayloadForStatus(targetStatus);
    await this.writeBacklight(payload);
  }

  /**
   * Select preset 9-byte backlight payload according to Agent status.
   */
  getBacklightPayloadForStatus(status: AgentPeripheralStatus): readonly number[] {
    switch (status) {
      case AgentPeripheralStatus.RUNNING:
        return NUPHY_PRESET_BLUE_EXECUTION;
      case AgentPeripheralStatus.NEEDS_INPUT:
        return NUPHY_PRESET_ORANGE_ATTENTION;
      case AgentPeripheralStatus.COMPLETED:
        return NUPHY_PRESET_GREEN_COMPLETION;
      case AgentPeripheralStatus.ERROR:
        return NUPHY_PRESET_RED_ERROR;
      case AgentPeripheralStatus.IDLE:
        // Dim white for IDLE
        return [0x03, 0x1e, 0x03, 0x00, 0x01, 0x00, 0x80, 0x80, 0x80];
      case AgentPeripheralStatus.INACTIVE:
      default:
        return NUPHY_PRESET_SIGNAL_OFF;
    }
  }

  /**
   * Write main backlight configuration and brightness register using SessionKey XOR encryption.
   */
  async writeBacklight(payload: readonly number[]): Promise<void> {
    if (!this.transport || this.sessionKey === null) return;

    // 1. Write main backlight state at address 0
    const mainReq = buildNuphyWriteRequest(NUPHY_REG_MAIN_BACKLIGHT, payload, this.sessionKey);
    await this.transport.send(mainReq);

    const mainResp = await this.transport.receive(1000);
    if (mainResp) {
      validateNuphyResponse(mainResp, NUPHY_CMD_SET_DATA, NUPHY_REG_MAIN_BACKLIGHT, this.sessionKey);
    }

    // 2. Write brightness register at address 1
    const brightness = payload[1] ?? 0;
    const brightReq = buildNuphyWriteRequest(NUPHY_REG_BRIGHTNESS, [brightness], this.sessionKey);
    await this.transport.send(brightReq);

    const brightResp = await this.transport.receive(1000);
    if (brightResp) {
      validateNuphyResponse(brightResp, NUPHY_CMD_SET_DATA, NUPHY_REG_BRIGHTNESS, this.sessionKey);
    }
  }
}
