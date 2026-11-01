/**
 * JSON-RPC 2.0 serialization, deserialization, builders and type guards.
 */

import {
  MIN_SLOT_INDEX,
  MAX_SLOT_INDEX,
  RPC_PARSE_ERROR,
  RPC_INVALID_REQUEST,
  NOTIFICATION_SNAPSHOT,
  NOTIFICATION_SLOT_UPDATED,
  NOTIFICATION_FOCUS_CHANGED,
  NOTIFICATION_SERVER_SHUTTING_DOWN,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
} from './constants.js';

import type {
  JsonRpcId,
  JsonRpcRequest,
  JsonRpcNotification,
  JsonRpcSuccessResponse,
  JsonRpcErrorResponse,
  JsonRpcResponse,
  JsonRpcMessage,
  SlotInfo,
  SnapshotNotification,
  SlotUpdatedNotification,
  FocusChangedNotification,
  ServerShuttingDownNotification,
  SwitchFocusRequest,
  SetBrainpowerRequest,
  SelectOptionRequest,
  AbortRequest,
  BrainpowerDirection,
  BrainpowerLevel,
  OptionAction,
} from './types.js';

/**
 * Protocol error class with JSON-RPC standard error code.
 */
export class ProtocolError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'ProtocolError';
    this.code = code;
    this.data = data;
    Object.setPrototypeOf(this, ProtocolError.prototype);
  }
}

/* ========================================================================== */
/*                             Validation Helpers                             */
/* ========================================================================== */

/**
 * Checks if a slot index is within the valid range [1, 12].
 */
export function isValidSlotIndex(slotIndex: unknown): slotIndex is number {
  return (
    typeof slotIndex === 'number' &&
    Number.isInteger(slotIndex) &&
    slotIndex >= MIN_SLOT_INDEX &&
    slotIndex <= MAX_SLOT_INDEX
  );
}

/**
 * Asserts that a slot index is within valid range [1, 12].
 */
export function assertValidSlotIndex(slotIndex: unknown): asserts slotIndex is number {
  if (!isValidSlotIndex(slotIndex)) {
    throw new ProtocolError(
      RPC_INVALID_REQUEST,
      `Slot index must be an integer between ${MIN_SLOT_INDEX} and ${MAX_SLOT_INDEX}, received: ${String(slotIndex)}`,
    );
  }
}

/* ========================================================================== */
/*                                Type Guards                                 */
/* ========================================================================== */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Check if the payload is a valid JSON-RPC 2.0 object (request, notification or response).
 */
export function isJsonRpcMessage(obj: unknown): obj is JsonRpcMessage {
  if (!isRecord(obj) || obj.jsonrpc !== '2.0') {
    return false;
  }
  return isJsonRpcRequest(obj) || isJsonRpcNotification(obj) || isJsonRpcResponse(obj);
}

/**
 * Type guard for JSON-RPC 2.0 Request.
 */
export function isJsonRpcRequest(obj: unknown): obj is JsonRpcRequest {
  if (!isRecord(obj) || obj.jsonrpc !== '2.0' || typeof obj.method !== 'string') {
    return false;
  }
  const idType = typeof obj.id;
  return (idType === 'string' || idType === 'number') && !('result' in obj) && !('error' in obj);
}

/**
 * Type guard for JSON-RPC 2.0 Notification.
 */
export function isJsonRpcNotification(obj: unknown): obj is JsonRpcNotification {
  if (!isRecord(obj) || obj.jsonrpc !== '2.0' || typeof obj.method !== 'string') {
    return false;
  }
  return !('id' in obj) && !('result' in obj) && !('error' in obj);
}

/**
 * Type guard for JSON-RPC 2.0 Success Response.
 */
export function isJsonRpcSuccessResponse(obj: unknown): obj is JsonRpcSuccessResponse {
  if (!isRecord(obj) || obj.jsonrpc !== '2.0' || !('result' in obj)) {
    return false;
  }
  const id = obj.id;
  return (typeof id === 'string' || typeof id === 'number' || id === null) && !('method' in obj);
}

/**
 * Type guard for JSON-RPC 2.0 Error Response.
 */
export function isJsonRpcErrorResponse(obj: unknown): obj is JsonRpcErrorResponse {
  if (!isRecord(obj) || obj.jsonrpc !== '2.0' || !isRecord(obj.error)) {
    return false;
  }
  const id = obj.id;
  const isIdValid = typeof id === 'string' || typeof id === 'number' || id === null;
  const errorObj = obj.error;
  return (
    isIdValid &&
    typeof errorObj.code === 'number' &&
    typeof errorObj.message === 'string' &&
    !('method' in obj)
  );
}

/**
 * Type guard for JSON-RPC 2.0 Response (Success or Error).
 */
export function isJsonRpcResponse(obj: unknown): obj is JsonRpcResponse {
  return isJsonRpcSuccessResponse(obj) || isJsonRpcErrorResponse(obj);
}

/* ========================================================================== */
/*                                  Builders                                  */
/* ========================================================================== */

export function createJsonRpcRequest<TMethod extends string, TParams>(
  id: string | number,
  method: TMethod,
  params?: TParams,
): JsonRpcRequest<TMethod, TParams> {
  const req: JsonRpcRequest<TMethod, TParams> = {
    jsonrpc: '2.0',
    id,
    method,
  };
  if (params !== undefined) {
    req.params = params;
  }
  return req;
}

export function createJsonRpcNotification<TMethod extends string, TParams>(
  method: TMethod,
  params?: TParams,
): JsonRpcNotification<TMethod, TParams> {
  const notif: JsonRpcNotification<TMethod, TParams> = {
    jsonrpc: '2.0',
    method,
  };
  if (params !== undefined) {
    notif.params = params;
  }
  return notif;
}

export function createJsonRpcSuccessResponse<TResult>(
  id: JsonRpcId,
  result: TResult,
): JsonRpcSuccessResponse<TResult> {
  return {
    jsonrpc: '2.0',
    id,
    result,
  };
}

export function createJsonRpcErrorResponse<TData = unknown>(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: TData,
): JsonRpcErrorResponse<TData> {
  const response: JsonRpcErrorResponse<TData> = {
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message,
    },
  };
  if (data !== undefined) {
    response.error.data = data;
  }
  return response;
}

/* ========================================================================== */
/*                         Domain-Specific Constructors                       */
/* ========================================================================== */

export function createSnapshotNotification(
  focusedSlot: number,
  slots: SlotInfo[],
): SnapshotNotification {
  return createJsonRpcNotification(NOTIFICATION_SNAPSHOT, { focusedSlot, slots });
}

export function createSlotUpdatedNotification(slot: SlotInfo): SlotUpdatedNotification {
  return createJsonRpcNotification(NOTIFICATION_SLOT_UPDATED, slot);
}

export function createFocusChangedNotification(
  focusedSlot: number,
  sessionId: string,
): FocusChangedNotification {
  return createJsonRpcNotification(NOTIFICATION_FOCUS_CHANGED, { focusedSlot, sessionId });
}

export function createServerShuttingDownNotification(
  reason?: string,
): ServerShuttingDownNotification {
  return createJsonRpcNotification(NOTIFICATION_SERVER_SHUTTING_DOWN, { reason });
}

export function createSwitchFocusRequest(
  id: string | number,
  slotIndex: number,
): SwitchFocusRequest {
  assertValidSlotIndex(slotIndex);
  return createJsonRpcRequest(id, METHOD_SWITCH_FOCUS, { slotIndex });
}

export function createSetBrainpowerRequest(
  id: string | number,
  slotIndex: number,
  options: { direction?: BrainpowerDirection; level?: BrainpowerLevel },
): SetBrainpowerRequest {
  assertValidSlotIndex(slotIndex);
  return createJsonRpcRequest(id, METHOD_SET_BRAINPOWER, {
    slotIndex,
    direction: options.direction,
    level: options.level,
  });
}

export function createSelectOptionRequest(
  id: string | number,
  slotIndex: number,
  action: OptionAction,
  optionIndex?: number,
): SelectOptionRequest {
  assertValidSlotIndex(slotIndex);
  return createJsonRpcRequest(id, METHOD_SELECT_OPTION, {
    slotIndex,
    action,
    optionIndex,
  });
}

export function createAbortRequest(
  id: string | number,
  slotIndex: number,
): AbortRequest {
  assertValidSlotIndex(slotIndex);
  return createJsonRpcRequest(id, METHOD_ABORT, { slotIndex });
}

/* ========================================================================== */
/*                             Codec Utilities                                */
/* ========================================================================== */

/**
 * Serializes a JSON-RPC message into UTF-8 JSON string.
 */
export function serializeJsonRpcMessage(message: JsonRpcMessage): string {
  return JSON.stringify(message);
}

/**
 * Parses and validates an incoming raw JSON string or object as a JSON-RPC 2.0 message.
 * @throws {ProtocolError} when parsing fails or the message does not conform to JSON-RPC 2.0
 */
export function parseJsonRpcMessage(raw: string | unknown): JsonRpcMessage {
  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new ProtocolError(
        RPC_PARSE_ERROR,
        `Failed to parse JSON string: ${(err as Error).message}`,
      );
    }
  } else {
    parsed = raw;
  }

  if (!isJsonRpcMessage(parsed)) {
    throw new ProtocolError(
      RPC_INVALID_REQUEST,
      'Invalid JSON-RPC 2.0 message structure',
      parsed,
    );
  }

  return parsed;
}
