import { describe, it, expect } from 'vitest';
import {
  AgentPeripheralStatus,
  STATUS_TO_BYTE_MAP,
  BYTE_TO_STATUS_MAP,
  BRAINPOWER_TO_BYTE_MAP,
  BYTE_TO_BRAINPOWER_MAP,
  VIA_RAW_HID_MAGIC,
  VIA_RAW_HID_REPORT_LENGTH,
  VIA_CMD_SET_ALL_SLOTS,
  VIA_CMD_SET_SLOT_LED,
  VIA_CMD_SET_FOCUS,
  buildViaSetAllSlotsReport,
  buildViaSetSlotLedReport,
  buildViaSetFocusReport,
  parseViaUplinkReport,
  NUPHY_VENDOR_ID,
  NUPHY_BLUETOOTH_VENDOR_ID,
  AIR75_V3_WIRED_PRODUCT_ID,
  AIR75_V3_DONGLE_PRODUCT_ID,
  AIR65_V3_WIRED_PRODUCT_ID,
  AIR65_V3_DONGLE_PRODUCT_ID,
  AIR96_V3_WIRED_PRODUCT_ID,
  AIR96_V3_DONGLE_PRODUCT_ID,
  SUPPORTED_NUPHY_PROFILES,
  resolveNuphyProductProfile,
  NUPHY_REPORT_LENGTH,
  NUPHY_PAYLOAD_LENGTH,
  NUPHY_HEADER_HOST,
  NUPHY_HEADER_DEVICE,
  NUPHY_CMD_TEMP_SESSION,
  NUPHY_CMD_SET_DATA,
  NUPHY_PRESET_BLUE_EXECUTION,
  NUPHY_PRESET_ORANGE_ATTENTION,
  NUPHY_PRESET_GREEN_COMPLETION,
  NUPHY_PRESET_SIGNAL_OFF,
  NUPHY_PRESET_RED_ERROR,
  nuphyChecksum,
  buildNuphySessionRequest,
  validateNuphySessionResponse,
  buildNuphyWriteRequest,
  validateNuphyResponse,
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
    expect(NUPHY_PRESET_RED_ERROR).toHaveLength(9);
  });

  it('resolves wired and 2.4G dongle Nuphy product profiles', () => {
    expect(NUPHY_VENDOR_ID).toBe(0x19f5);
    expect(NUPHY_BLUETOOTH_VENDOR_ID).toBe(0x07d7);
    expect(SUPPORTED_NUPHY_PROFILES).toHaveLength(3);

    expect(resolveNuphyProductProfile(AIR75_V3_WIRED_PRODUCT_ID)).toEqual({
      profile: expect.objectContaining({ model: 'Air75 V3 ANSI', wiredProductId: 0x1028 }),
      transport: 'usb',
    });
    expect(resolveNuphyProductProfile(AIR75_V3_DONGLE_PRODUCT_ID)).toEqual({
      profile: expect.objectContaining({ model: 'Air75 V3 ANSI', dongleProductId: 0x2620 }),
      transport: '2.4g',
    });
    expect(resolveNuphyProductProfile(AIR65_V3_WIRED_PRODUCT_ID)?.transport).toBe('usb');
    expect(resolveNuphyProductProfile(AIR65_V3_DONGLE_PRODUCT_ID)?.transport).toBe('2.4g');
    expect(resolveNuphyProductProfile(AIR96_V3_WIRED_PRODUCT_ID)?.transport).toBe('usb');
    expect(resolveNuphyProductProfile(AIR96_V3_DONGLE_PRODUCT_ID)?.transport).toBe('2.4g');
    expect(resolveNuphyProductProfile(0xffff)).toBeNull();
  });
});

describe('VIA Frame Builders and Parser', () => {
  it('builds set all slots report correctly', () => {
    const report = buildViaSetAllSlotsReport(2, [
      { slotIndex: 1, status: AgentPeripheralStatus.IDLE },
      { slotIndex: 2, status: AgentPeripheralStatus.RUNNING },
      { slotIndex: 3, status: AgentPeripheralStatus.NEEDS_INPUT },
    ]);

    expect(report).toHaveLength(VIA_RAW_HID_REPORT_LENGTH);
    expect(report[0]).toBe(VIA_RAW_HID_MAGIC);
    expect(report[1]).toBe(VIA_CMD_SET_ALL_SLOTS);
    expect(report[2]).toBe(2); // focusedSlot
    expect(report[3]).toBe(STATUS_TO_BYTE_MAP[AgentPeripheralStatus.IDLE]); // slot 1
    expect(report[4]).toBe(STATUS_TO_BYTE_MAP[AgentPeripheralStatus.RUNNING]); // slot 2
    expect(report[5]).toBe(STATUS_TO_BYTE_MAP[AgentPeripheralStatus.NEEDS_INPUT]); // slot 3
  });

  it('builds set slot LED and set focus reports correctly', () => {
    const slotLed = buildViaSetSlotLedReport(5, AgentPeripheralStatus.RUNNING, 'high');
    expect(slotLed[0]).toBe(VIA_RAW_HID_MAGIC);
    expect(slotLed[1]).toBe(VIA_CMD_SET_SLOT_LED);
    expect(slotLed[2]).toBe(5);
    expect(slotLed[3]).toBe(STATUS_TO_BYTE_MAP[AgentPeripheralStatus.RUNNING]);
    expect(slotLed[4]).toBe(BRAINPOWER_TO_BYTE_MAP['high']);

    const focus = buildViaSetFocusReport(7);
    expect(focus[0]).toBe(VIA_RAW_HID_MAGIC);
    expect(focus[1]).toBe(VIA_CMD_SET_FOCUS);
    expect(focus[2]).toBe(7);
  });

  it('parses valid and invalid VIA uplink events', () => {
    // Switch focus
    const f3Event = new Uint8Array(32);
    f3Event[0] = VIA_RAW_HID_MAGIC;
    f3Event[1] = 0x10;
    f3Event[2] = 3;
    expect(parseViaUplinkReport(f3Event)).toEqual({ type: 'switchFocus', slotIndex: 3 });

    // Knob CW / CCW / Press
    const knobCw = new Uint8Array(32);
    knobCw[0] = VIA_RAW_HID_MAGIC;
    knobCw[1] = 0x11;
    knobCw[2] = 0x01;
    expect(parseViaUplinkReport(knobCw)).toEqual({ type: 'knob', action: 'stepUp' });

    const knobCcw = new Uint8Array(32);
    knobCcw[0] = VIA_RAW_HID_MAGIC;
    knobCcw[1] = 0x11;
    knobCcw[2] = 0x02;
    expect(parseViaUplinkReport(knobCcw)).toEqual({ type: 'knob', action: 'stepDown' });

    const knobPress = new Uint8Array(32);
    knobPress[0] = VIA_RAW_HID_MAGIC;
    knobPress[1] = 0x11;
    knobPress[2] = 0x03;
    expect(parseViaUplinkReport(knobPress)).toEqual({ type: 'knob', action: 'press' });

    // Option decision
    const accept = new Uint8Array(32);
    accept[0] = VIA_RAW_HID_MAGIC;
    accept[1] = 0x12;
    accept[2] = 0x00;
    expect(parseViaUplinkReport(accept)).toEqual({ type: 'option', action: 'ACCEPT' });

    // Invalid magic or unknown event
    expect(parseViaUplinkReport(new Uint8Array([0x00, 0x10, 0x01]))).toBeNull();
    expect(parseViaUplinkReport(new Uint8Array([VIA_RAW_HID_MAGIC, 0x99, 0x00]))).toBeNull();
  });
});

describe('Nuphy Protocol Framing, Checksum & XOR Session', () => {
  it('correctly builds session request and validates session response', () => {
    const challenge = new Uint8Array(NUPHY_PAYLOAD_LENGTH);
    for (let i = 0; i < challenge.length; i++) challenge[i] = (i * 7 + 3) & 0xff;

    const request = buildNuphySessionRequest(challenge);
    expect(request).toHaveLength(NUPHY_REPORT_LENGTH);
    expect(request[0]).toBe(NUPHY_HEADER_HOST);
    expect(request[1]).toBe(NUPHY_CMD_TEMP_SESSION);
    expect(request[3]).toBe(nuphyChecksum(request));

    // Simulated device response with session key 0x5a
    const sessionKey = 0x5a;
    const response = new Uint8Array(NUPHY_REPORT_LENGTH);
    response[0] = NUPHY_HEADER_DEVICE;
    response[1] = NUPHY_CMD_TEMP_SESSION;
    response[4] = sessionKey;
    response[5] = sessionKey;
    response[6] = sessionKey;
    response[7] = sessionKey;
    for (let i = 0; i < challenge.length; i++) {
      response[8 + i] = challenge[i] ^ sessionKey;
    }
    response[3] = nuphyChecksum(response);

    const extractedKey = validateNuphySessionResponse(response, challenge);
    expect(extractedKey).toBe(sessionKey);
  });

  it('correctly builds and validates XOR encoded write request and response', () => {
    const sessionKey = 0x47;
    const address = 0x0001;
    const payload = [0x03, 0x64, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0xff];

    const writeReq = buildNuphyWriteRequest(address, payload, sessionKey);
    expect(writeReq[0]).toBe(NUPHY_HEADER_HOST);
    expect(writeReq[1]).toBe(NUPHY_CMD_SET_DATA);
    expect(writeReq[4]).toBe(payload.length ^ sessionKey);
    expect(writeReq[5]).toBe((address & 0xff) ^ sessionKey);
    expect(writeReq[6]).toBe(((address >> 8) & 0xff) ^ sessionKey);
    expect(writeReq[7]).toBe(sessionKey);
    expect(writeReq[3]).toBe(nuphyChecksum(writeReq));

    // Device response
    const writeResp = new Uint8Array(NUPHY_REPORT_LENGTH);
    writeResp[0] = NUPHY_HEADER_DEVICE;
    writeResp[1] = NUPHY_CMD_SET_DATA;
    writeResp[4] = payload.length ^ sessionKey;
    writeResp[5] = (address & 0xff) ^ sessionKey;
    writeResp[6] = ((address >> 8) & 0xff) ^ sessionKey;
    writeResp[7] = 0 ^ sessionKey; // handle = 0
    for (let i = 0; i < payload.length; i++) {
      writeResp[8 + i] = payload[i] ^ sessionKey;
    }
    writeResp[3] = nuphyChecksum(writeResp);

    const decoded = validateNuphyResponse(writeResp, NUPHY_CMD_SET_DATA, address, sessionKey);
    expect(Array.from(decoded)).toEqual(payload);
  });
});

