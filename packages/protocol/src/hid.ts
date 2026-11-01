/**
 * Binary report specifications and mapping helpers for VIA Raw HID and Nuphy Keyboards.
 */

import { AgentPeripheralStatus, type BrainpowerLevel, type OptionAction } from './types.js';

/* ========================================================================== */
/*                             VIA / QMK Raw HID                              */
/* ========================================================================== */

/** Magic header byte identifying DSH peripheral protocol in VIA frames */
export const VIA_RAW_HID_MAGIC = 0xd5;

/** Total byte size of VIA Raw HID buffer */
export const VIA_RAW_HID_REPORT_LENGTH = 32;

/** Usage Page and ID standard for VIA */
export const VIA_USAGE_PAGE = 0xff60;
export const VIA_USAGE_ID = 0x61;

/** VIA Downlink command bytes (Daemon -> Keyboard) */
export const VIA_CMD_SET_SLOT_LED = 0x01;
export const VIA_CMD_SET_ALL_SLOTS = 0x02;
export const VIA_CMD_SET_FOCUS = 0x03;
export const VIA_CMD_RESET = 0xff;

/** VIA Uplink event bytes (Keyboard -> Daemon) */
export const VIA_EVENT_SWITCH_FOCUS = 0x10;
export const VIA_EVENT_KNOB = 0x11;
export const VIA_EVENT_OPTION = 0x12;

/** Knob physical direction codes */
export const KNOB_ACTION_CW = 0x01; // Clockwise
export const KNOB_ACTION_CCW = 0x02; // Counter-clockwise
export const KNOB_ACTION_PRESS = 0x03; // Rotary press

/**
 * Mapping table from AgentPeripheralStatus to 1-byte status code in VIA report.
 */
export const STATUS_TO_BYTE_MAP: Record<AgentPeripheralStatus, number> = {
  [AgentPeripheralStatus.INACTIVE]: 0x00,
  [AgentPeripheralStatus.IDLE]: 0x01,
  [AgentPeripheralStatus.RUNNING]: 0x02,
  [AgentPeripheralStatus.NEEDS_INPUT]: 0x03,
  [AgentPeripheralStatus.COMPLETED]: 0x04,
  [AgentPeripheralStatus.ERROR]: 0x05,
};

export const BYTE_TO_STATUS_MAP: Record<number, AgentPeripheralStatus> = {
  0x00: AgentPeripheralStatus.INACTIVE,
  0x01: AgentPeripheralStatus.IDLE,
  0x02: AgentPeripheralStatus.RUNNING,
  0x03: AgentPeripheralStatus.NEEDS_INPUT,
  0x04: AgentPeripheralStatus.COMPLETED,
  0x05: AgentPeripheralStatus.ERROR,
};

/**
 * Mapping table from BrainpowerLevel to 1-byte level in VIA report.
 */
export const BRAINPOWER_TO_BYTE_MAP: Record<BrainpowerLevel, number> = {
  low: 0x01,
  medium: 0x02,
  high: 0x03,
  max: 0x04,
};

export const BYTE_TO_BRAINPOWER_MAP: Record<number, BrainpowerLevel> = {
  0x01: 'low',
  0x02: 'medium',
  0x03: 'high',
  0x04: 'max',
};

export type ViaUplinkEvent =
  | { type: 'switchFocus'; slotIndex: number }
  | { type: 'knob'; action: 'stepUp' | 'stepDown' | 'press' }
  | { type: 'option'; action: OptionAction };

/**
 * Build a 32-byte VIA report to update all 12 slots and current focus.
 */
export function buildViaSetAllSlotsReport(
  focusedSlot: number,
  slots: Array<{ slotIndex: number; status: AgentPeripheralStatus }>,
): Uint8Array {
  const report = new Uint8Array(VIA_RAW_HID_REPORT_LENGTH);
  report[0] = VIA_RAW_HID_MAGIC;
  report[1] = VIA_CMD_SET_ALL_SLOTS;
  report[2] = Math.min(Math.max(focusedSlot, 0), 12);

  for (const slot of slots) {
    if (slot.slotIndex >= 1 && slot.slotIndex <= 12) {
      report[2 + slot.slotIndex] = STATUS_TO_BYTE_MAP[slot.status] ?? 0x00;
    }
  }
  return report;
}

/**
 * Build a 32-byte VIA report to update a single slot LED and brainpower.
 */
export function buildViaSetSlotLedReport(
  slotIndex: number,
  status: AgentPeripheralStatus,
  brainpower?: BrainpowerLevel,
): Uint8Array {
  const report = new Uint8Array(VIA_RAW_HID_REPORT_LENGTH);
  report[0] = VIA_RAW_HID_MAGIC;
  report[1] = VIA_CMD_SET_SLOT_LED;
  report[2] = slotIndex;
  report[3] = STATUS_TO_BYTE_MAP[status] ?? 0x00;
  report[4] = brainpower ? (BRAINPOWER_TO_BYTE_MAP[brainpower] ?? 0x00) : 0x00;
  return report;
}

/**
 * Build a 32-byte VIA report to set focus.
 */
export function buildViaSetFocusReport(focusedSlot: number): Uint8Array {
  const report = new Uint8Array(VIA_RAW_HID_REPORT_LENGTH);
  report[0] = VIA_RAW_HID_MAGIC;
  report[1] = VIA_CMD_SET_FOCUS;
  report[2] = focusedSlot;
  return report;
}

/**
 * Parse a 32-byte VIA uplink report from keyboard into a typed event.
 */
export function parseViaUplinkReport(report: Uint8Array): ViaUplinkEvent | null {
  if (report.length < 3 || report[0] !== VIA_RAW_HID_MAGIC) {
    return null;
  }
  const eventCode = report[1];
  switch (eventCode) {
    case VIA_EVENT_SWITCH_FOCUS: {
      const slotIndex = report[2];
      if (slotIndex >= 1 && slotIndex <= 12) {
        return { type: 'switchFocus', slotIndex };
      }
      return null;
    }
    case VIA_EVENT_KNOB: {
      const knobAction = report[2];
      if (knobAction === KNOB_ACTION_CW) {
        return { type: 'knob', action: 'stepUp' };
      }
      if (knobAction === KNOB_ACTION_CCW) {
        return { type: 'knob', action: 'stepDown' };
      }
      if (knobAction === KNOB_ACTION_PRESS) {
        return { type: 'knob', action: 'press' };
      }
      return null;
    }
    case VIA_EVENT_OPTION: {
      const optionCode = report[2];
      if (optionCode === 0x00) return { type: 'option', action: 'ACCEPT' };
      if (optionCode === 0x01) return { type: 'option', action: 'REJECT' };
      if (optionCode === 0x02) return { type: 'option', action: 'ALWAYS_ALLOW' };
      return null;
    }
    default:
      return null;
  }
}

/* ========================================================================== */
/*                               Nuphy Air V3                                 */
/* ========================================================================== */

export const NUPHY_VENDOR_ID = 0x19f5;
export const AIR65_V3_PRODUCT_ID = 0x102b;

export const NUPHY_REPORT_LENGTH = 64;
export const NUPHY_PAYLOAD_LENGTH = 56;
export const NUPHY_HEADER_HOST = 0x55;
export const NUPHY_HEADER_DEVICE = 0xaa;

export const NUPHY_CMD_GET_DATA = 0xd5;
export const NUPHY_CMD_SET_DATA = 0xd6;
export const NUPHY_CMD_TEMP_SESSION = 0xee;

/** Nuphy Register Addresses */
export const NUPHY_REG_MAIN_BACKLIGHT = 0x0000;
export const NUPHY_REG_BRIGHTNESS = 0x0001;

/**
 * Nuphy Preset Color Sequence Payloads (Keyphore-Derived).
 */
export const NUPHY_PRESET_BLUE_EXECUTION = Object.freeze([
  0x03, 0x64, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff,
]);

export const NUPHY_PRESET_ORANGE_ATTENTION = Object.freeze([
  0x03, 0x64, 0x03, 0x00, 0x01, 0x00, 0xff, 0x84, 0x00,
]);

export const NUPHY_PRESET_GREEN_COMPLETION = Object.freeze([
  0x03, 0x64, 0x03, 0x00, 0x01, 0x00, 0x00, 0xff, 0x00,
]);

export const NUPHY_PRESET_RED_ERROR = Object.freeze([
  0x03, 0x64, 0x03, 0x00, 0x01, 0x00, 0xff, 0x00, 0x00,
]);

export const NUPHY_PRESET_SIGNAL_OFF = Object.freeze([
  0x03, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * Calculate 8-bit wrapping checksum for Nuphy report [4..64].
 */
export function nuphyChecksum(report: Uint8Array): number {
  let sum = 0;
  for (let i = 4; i < report.length; i++) {
    sum = (sum + report[i]) & 0xff;
  }
  return sum;
}

/**
 * Build a 64-byte Temporary Session request given a 56-byte challenge.
 */
export function buildNuphySessionRequest(challenge: Uint8Array): Uint8Array {
  if (challenge.length !== NUPHY_PAYLOAD_LENGTH) {
    throw new Error(`Challenge must be exactly ${NUPHY_PAYLOAD_LENGTH} bytes`);
  }
  const report = new Uint8Array(NUPHY_REPORT_LENGTH);
  report[0] = NUPHY_HEADER_HOST;
  report[1] = NUPHY_CMD_TEMP_SESSION;
  report.set(challenge, 8);
  report[3] = nuphyChecksum(report);
  return report;
}

/**
 * Validate a 64-byte Temporary Session response and extract the SessionKey.
 */
export function validateNuphySessionResponse(response: Uint8Array, challenge: Uint8Array): number {
  if (response.length !== NUPHY_REPORT_LENGTH) {
    throw new Error(`Response must be ${NUPHY_REPORT_LENGTH} bytes`);
  }
  if (response[0] !== NUPHY_HEADER_DEVICE) {
    throw new Error(`Invalid response direction: expected 0xaa, got 0x${response[0].toString(16)}`);
  }
  if (response[1] !== NUPHY_CMD_TEMP_SESSION) {
    throw new Error(`Invalid response command: expected 0xee, got 0x${response[1].toString(16)}`);
  }
  if (response[3] !== nuphyChecksum(response)) {
    throw new Error('Nuphy checksum mismatch');
  }

  const key = response[4];
  for (let i = 4; i < 8; i++) {
    if (response[i] !== key) {
      throw new Error('Temporary-session response contains mismatched key bytes');
    }
  }

  for (let i = 0; i < NUPHY_PAYLOAD_LENGTH; i++) {
    if (response[8 + i] !== (challenge[i] ^ key)) {
      throw new Error(`Temporary-session response challenge mismatch at index ${i}`);
    }
  }

  return key;
}

/**
 * Build a 64-byte SetData / Write request with SessionKey XOR encoding.
 */
export function buildNuphyWriteRequest(
  address: number,
  payload: Uint8Array | readonly number[] | number[],
  sessionKey: number,
): Uint8Array {
  const payloadArr = Array.isArray(payload) ? payload : Array.from(payload);
  if (payloadArr.length > NUPHY_PAYLOAD_LENGTH) {
    throw new Error(`Payload exceeds maximum of ${NUPHY_PAYLOAD_LENGTH} bytes`);
  }

  const report = new Uint8Array(NUPHY_REPORT_LENGTH);
  report[0] = NUPHY_HEADER_HOST;
  report[1] = NUPHY_CMD_SET_DATA;
  report[4] = payloadArr.length ^ sessionKey;
  report[5] = (address & 0xff) ^ sessionKey;
  report[6] = ((address >> 8) & 0xff) ^ sessionKey;
  report[7] = sessionKey;

  for (let i = 0; i < payloadArr.length; i++) {
    report[8 + i] = payloadArr[i] ^ sessionKey;
  }

  report[3] = nuphyChecksum(report);
  return report;
}

/**
 * Build a 64-byte GetData / Read request with SessionKey XOR encoding.
 */
export function buildNuphyReadRequest(
  address: number,
  responseLen: number,
  sessionKey: number,
): Uint8Array {
  const report = new Uint8Array(NUPHY_REPORT_LENGTH);
  report[0] = NUPHY_HEADER_HOST;
  report[1] = NUPHY_CMD_GET_DATA;
  report[4] = responseLen ^ sessionKey;
  report[5] = (address & 0xff) ^ sessionKey;
  report[6] = ((address >> 8) & 0xff) ^ sessionKey;
  report[7] = sessionKey;
  report[3] = nuphyChecksum(report);
  return report;
}

/**
 * Validate a 64-byte Nuphy response and decode the payload using SessionKey XOR.
 */
export function validateNuphyResponse(
  response: Uint8Array,
  expectedCommand: number,
  expectedAddress: number,
  sessionKey: number,
): Uint8Array {
  if (response.length !== NUPHY_REPORT_LENGTH) {
    throw new Error(`Response must be ${NUPHY_REPORT_LENGTH} bytes`);
  }
  if (response[0] !== NUPHY_HEADER_DEVICE) {
    throw new Error('Invalid device header');
  }
  if (response[1] !== expectedCommand) {
    throw new Error(`Command mismatch: expected 0x${expectedCommand.toString(16)}, got 0x${response[1].toString(16)}`);
  }
  if (response[3] !== nuphyChecksum(response)) {
    throw new Error('Nuphy checksum mismatch');
  }

  const length = response[4] ^ sessionKey;
  const address = (response[5] ^ sessionKey) | ((response[6] ^ sessionKey) << 8);
  const handle = response[7] ^ sessionKey;

  if (address !== expectedAddress) {
    throw new Error(`Address mismatch: expected ${expectedAddress}, got ${address}`);
  }
  if (handle !== 0) {
    throw new Error(`Handle mismatch: expected 0, got ${handle}`);
  }

  const payload = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    payload[i] = response[8 + i] ^ sessionKey;
  }
  return payload;
}

