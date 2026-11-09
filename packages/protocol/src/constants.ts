/**
 * Protocol constants for DeepSeek Harness HID peripheral bridge.
 */

export const PROTOCOL_VERSION = '0.1.0-alpha';

/**
 * Default network connection parameters for Server <-> Daemon communication.
 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_DSH_PORT = 45678;
export const DEFAULT_TRAE_PORT = 45679;
export const DEFAULT_PORT = (typeof process !== 'undefined' && process.env?.PERIPHERAL_PORT)
  ? parseInt(process.env.PERIPHERAL_PORT, 10)
  : DEFAULT_TRAE_PORT;
export const DEFAULT_PATH = '/peripheral/v1';
export const DEFAULT_WS_URL = `ws://${DEFAULT_HOST}:${DEFAULT_PORT}${DEFAULT_PATH}`;

/**
 * Slot configuration constraints.
 */
export const MIN_SLOT_INDEX = 1;
export const MAX_SLOT_INDEX = 12;
export const TOTAL_SLOTS = 12;

/**
 * Server -> Daemon / UI Notification Methods.
 */
export const NOTIFICATION_SNAPSHOT = 'peripheral/snapshot';
export const NOTIFICATION_SLOT_UPDATED = 'peripheral/slotUpdated';
export const NOTIFICATION_FOCUS_CHANGED = 'peripheral/focusChanged';
export const NOTIFICATION_SERVER_SHUTTING_DOWN = 'peripheral/serverShuttingDown';
export const NOTIFICATION_TRANSPORT_CHANGED = 'peripheral/transportChanged';

/**
 * Daemon -> Server Request Methods.
 */
export const METHOD_SWITCH_FOCUS = 'peripheral/switchFocus';
export const METHOD_SET_BRAINPOWER = 'peripheral/setBrainpower';
export const METHOD_SELECT_OPTION = 'peripheral/selectOption';
export const METHOD_ABORT = 'peripheral/abort';

/**
 * JSON-RPC 2.0 Standard Error Codes.
 */
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INVALID_PARAMS = -32602;
export const RPC_INTERNAL_ERROR = -32603;

/**
 * Custom Business Error Codes.
 */
export const RPC_SLOT_OUT_OF_BOUNDS = -32001;
export const RPC_SESSION_NOT_FOUND = -32002;
export const RPC_OPERATION_FAILED = -32003;
