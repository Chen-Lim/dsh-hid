import { describe, it, expect } from 'vitest';
import {
  AgentPeripheralStatus,
  createSnapshotNotification,
  createSlotUpdatedNotification,
  createFocusChangedNotification,
  createServerShuttingDownNotification,
  createTransportChangedNotification,
  createSwitchFocusRequest,
  createSetBrainpowerRequest,
  createSelectOptionRequest,
  createAbortRequest,
  createJsonRpcSuccessResponse,
  createJsonRpcErrorResponse,
  serializeJsonRpcMessage,
  parseJsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  isValidSlotIndex,
  assertValidSlotIndex,
  ProtocolError,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  NOTIFICATION_SNAPSHOT,
  NOTIFICATION_SLOT_UPDATED,
  NOTIFICATION_FOCUS_CHANGED,
  NOTIFICATION_SERVER_SHUTTING_DOWN,
  NOTIFICATION_TRANSPORT_CHANGED,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
} from '../src/index.js';

describe('Slot Index Validation', () => {
  it('validates slot index range [1, 12]', () => {
    expect(isValidSlotIndex(1)).toBe(true);
    expect(isValidSlotIndex(12)).toBe(true);
    expect(isValidSlotIndex(6)).toBe(true);

    expect(isValidSlotIndex(0)).toBe(false);
    expect(isValidSlotIndex(13)).toBe(false);
    expect(isValidSlotIndex(-1)).toBe(false);
    expect(isValidSlotIndex(1.5)).toBe(false);
    expect(isValidSlotIndex('1')).toBe(false);
    expect(isValidSlotIndex(null)).toBe(false);
  });

  it('assertValidSlotIndex throws ProtocolError on invalid index', () => {
    expect(() => assertValidSlotIndex(0)).toThrow(ProtocolError);
    expect(() => assertValidSlotIndex(13)).toThrow(ProtocolError);
    expect(() => assertValidSlotIndex(5)).not.toThrow();
  });
});

describe('JSON-RPC Notification Builders & Roundtrip', () => {
  it('creates and serializes snapshot notification', () => {
    const notif = createSnapshotNotification(1, [
      {
        slotIndex: 1,
        sessionId: 'sess-001',
        status: AgentPeripheralStatus.RUNNING,
        brainpower: 'high',
        activeTool: 'bash',
      },
      {
        slotIndex: 2,
        sessionId: 'sess-002',
        status: AgentPeripheralStatus.IDLE,
        brainpower: 'medium',
      },
    ]);

    expect(notif.jsonrpc).toBe('2.0');
    expect(notif.method).toBe(NOTIFICATION_SNAPSHOT);
    expect(notif.params.focusedSlot).toBe(1);
    expect(notif.params.slots).toHaveLength(2);

    const json = serializeJsonRpcMessage(notif);
    const parsed = parseJsonRpcMessage(json);

    expect(isJsonRpcNotification(parsed)).toBe(true);
    expect(parsed).toEqual(notif);
  });

  it('creates and serializes slotUpdated notification with question', () => {
    const notif = createSlotUpdatedNotification({
      slotIndex: 3,
      sessionId: 'sess-003',
      status: AgentPeripheralStatus.NEEDS_INPUT,
      question: {
        prompt: 'Deploy to production?',
        options: ['Yes', 'No'],
      },
    });

    expect(notif.method).toBe(NOTIFICATION_SLOT_UPDATED);
    const json = serializeJsonRpcMessage(notif);
    const parsed = parseJsonRpcMessage(json);
    expect(parsed).toEqual(notif);
  });

  it('creates focusChanged, serverShuttingDown, and transportChanged notifications', () => {
    const focusNotif = createFocusChangedNotification(2, 'sess-002');
    expect(focusNotif.method).toBe(NOTIFICATION_FOCUS_CHANGED);
    expect(focusNotif.params.focusedSlot).toBe(2);

    const shutdownNotif = createServerShuttingDownNotification('Host restart');
    expect(shutdownNotif.method).toBe(NOTIFICATION_SERVER_SHUTTING_DOWN);
    expect(shutdownNotif.params?.reason).toBe('Host restart');

    const transportNotif = createTransportChangedNotification({
      transport: '2.4g',
      model: 'Air75 V3 ANSI',
      vendorId: 0x19f5,
      productId: 0x2620,
      capabilities: {
        rgb: true,
        keys: true,
        ledBlink: false,
        wireless: true,
      },
    });
    expect(transportNotif.method).toBe(NOTIFICATION_TRANSPORT_CHANGED);
    expect(transportNotif.params.transport).toBe('2.4g');
    expect(transportNotif.params.capabilities.wireless).toBe(true);

    const parsed = parseJsonRpcMessage(serializeJsonRpcMessage(transportNotif));
    expect(isJsonRpcNotification(parsed)).toBe(true);
    expect(parsed).toEqual(transportNotif);
  });
});

describe('JSON-RPC Request Builders & Responses', () => {
  it('creates switchFocus request', () => {
    const req = createSwitchFocusRequest(101, 4);
    expect(req.jsonrpc).toBe('2.0');
    expect(req.id).toBe(101);
    expect(req.method).toBe(METHOD_SWITCH_FOCUS);
    expect(req.params.slotIndex).toBe(4);

    const parsed = parseJsonRpcMessage(serializeJsonRpcMessage(req));
    expect(isJsonRpcRequest(parsed)).toBe(true);
    expect(parsed).toEqual(req);
  });

  it('creates setBrainpower request', () => {
    const req = createSetBrainpowerRequest(102, 1, { direction: 'stepUp' });
    expect(req.method).toBe(METHOD_SET_BRAINPOWER);
    expect(req.params.direction).toBe('stepUp');
  });

  it('creates selectOption request', () => {
    const req = createSelectOptionRequest(103, 1, 'ACCEPT', 0);
    expect(req.method).toBe(METHOD_SELECT_OPTION);
    expect(req.params.action).toBe('ACCEPT');
    expect(req.params.optionIndex).toBe(0);
  });

  it('creates abort request', () => {
    const req = createAbortRequest('req-uuid-1', 2);
    expect(req.method).toBe(METHOD_ABORT);
    expect(req.params.slotIndex).toBe(2);
  });

  it('throws on creating requests with out-of-range slot indices', () => {
    expect(() => createSwitchFocusRequest(1, 0)).toThrow(ProtocolError);
    expect(() => createSetBrainpowerRequest(2, 13, { direction: 'stepDown' })).toThrow(ProtocolError);
    expect(() => createSelectOptionRequest(3, -1, 'REJECT')).toThrow(ProtocolError);
    expect(() => createAbortRequest(4, 99)).toThrow(ProtocolError);
  });

  it('handles success and error responses', () => {
    const successRes = createJsonRpcSuccessResponse(1001, { success: true, focusedSlot: 2 });
    expect(isJsonRpcSuccessResponse(successRes)).toBe(true);
    expect(isJsonRpcErrorResponse(successRes)).toBe(false);

    const parsedSuccess = parseJsonRpcMessage(serializeJsonRpcMessage(successRes));
    expect(parsedSuccess).toEqual(successRes);

    const errorRes = createJsonRpcErrorResponse(1002, -32001, 'Slot not found', { slotIndex: 15 });
    expect(isJsonRpcErrorResponse(errorRes)).toBe(true);
    expect(isJsonRpcSuccessResponse(errorRes)).toBe(false);

    const parsedError = parseJsonRpcMessage(serializeJsonRpcMessage(errorRes));
    expect(parsedError).toEqual(errorRes);
  });
});

describe('JSON-RPC Parse & Validation Errors', () => {
  it('throws RPC_PARSE_ERROR on malformed JSON string', () => {
    expect(() => parseJsonRpcMessage('{ invalid json')).toThrowError(ProtocolError);
    try {
      parseJsonRpcMessage('{ invalid json');
    } catch (e) {
      expect((e as ProtocolError).code).toBe(RPC_PARSE_ERROR);
    }
  });

  it('throws RPC_INVALID_REQUEST on invalid JSON-RPC structure', () => {
    // Missing jsonrpc: "2.0"
    expect(() => parseJsonRpcMessage(JSON.stringify({ id: 1, method: 'test' }))).toThrowError(ProtocolError);
    // Invalid jsonrpc version
    expect(() => parseJsonRpcMessage(JSON.stringify({ jsonrpc: '1.0', id: 1, method: 'test' }))).toThrowError(ProtocolError);
    // Non-object
    expect(() => parseJsonRpcMessage(JSON.stringify(42))).toThrowError(ProtocolError);
    // Array instead of object
    expect(() => parseJsonRpcMessage(JSON.stringify([]))).toThrowError(ProtocolError);
  });
});
