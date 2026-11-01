import { describe, it, expect } from 'vitest';
import {
  AgentPeripheralStatus,
  STATUS_TO_BYTE_MAP,
  BYTE_TO_STATUS_MAP,
  BRAINPOWER_TO_BYTE_MAP,
  BYTE_TO_BRAINPOWER_MAP,
  VIA_RAW_HID_MAGIC,
  VIA_RAW_HID_REPORT_LENGTH,
  NUPHY_REPORT_LENGTH,
  NUPHY_PRESET_BLUE_EXECUTION,
  NUPHY_PRESET_ORANGE_ATTENTION,
  NUPHY_PRESET_GREEN_COMPLETION,
  NUPHY_PRESET_SIGNAL_OFF,
} from '../src/index.js';

describe('HID Constants & Mapping Tables', () => {
  it('verifies bijective status to byte mapping', () => {
    const statuses = Object.values(AgentPeripheralStatus);
    for (const status of statuses) {
      const byte = STATUS_TO_BYTE_MAP[status];
      expect(typeof byte).toBe('number');
      expect(BYTE_TO_STATUS_MAP[byte]).toBe(status);
    }
  });

  it('verifies bijective brainpower to byte mapping', () => {
    const levels = ['low', 'medium', 'high', 'max'] as const;
    for (const level of levels) {
      const byte = BRAINPOWER_TO_BYTE_MAP[level];
      expect(typeof byte).toBe('number');
      expect(BYTE_TO_BRAINPOWER_MAP[byte]).toBe(level);
    }
  });

  it('verifies VIA and Nuphy protocol framing constants', () => {
    expect(VIA_RAW_HID_MAGIC).toBe(0xd5);
    expect(VIA_RAW_HID_REPORT_LENGTH).toBe(32);
    expect(NUPHY_REPORT_LENGTH).toBe(64);

    expect(NUPHY_PRESET_BLUE_EXECUTION).toHaveLength(9);
    expect(NUPHY_PRESET_ORANGE_ATTENTION).toHaveLength(9);
    expect(NUPHY_PRESET_GREEN_COMPLETION).toHaveLength(9);
    expect(NUPHY_PRESET_SIGNAL_OFF).toHaveLength(9);
  });
});
