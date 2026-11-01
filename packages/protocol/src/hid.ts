/**
 * Binary report specifications and mapping helpers for VIA Raw HID and Nuphy Keyboards.
 */

import { AgentPeripheralStatus, type BrainpowerLevel } from './types.js';

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

/* ========================================================================== */
/*                               Nuphy Air V3                                 */
/* ========================================================================== */

export const NUPHY_REPORT_LENGTH = 64;
export const NUPHY_HEADER_HOST = 0x55;
export const NUPHY_HEADER_DEVICE = 0xaa;

export const NUPHY_CMD_TEMP_SESSION = 0xee;
export const NUPHY_CMD_SET_DATA = 0xd6;

/** Nuphy Register Addresses */
export const NUPHY_REG_MAIN_BACKLIGHT = 0x0001;
export const NUPHY_REG_SIDELIGHT_STATUS = 0x0002;

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

export const NUPHY_PRESET_SIGNAL_OFF = Object.freeze([
  0x03, 0x00, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
]);
