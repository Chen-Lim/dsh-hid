/**
 * Core domain types and JSON-RPC 2.0 schemas for DSH HID peripheral bridge.
 */

import type {
  NOTIFICATION_SNAPSHOT,
  NOTIFICATION_SLOT_UPDATED,
  NOTIFICATION_FOCUS_CHANGED,
  NOTIFICATION_SERVER_SHUTTING_DOWN,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
} from './constants.js';

/**
 * Status of an agent associated with a physical slot.
 */
export enum AgentPeripheralStatus {
  INACTIVE = 'INACTIVE',
  IDLE = 'IDLE',
  RUNNING = 'RUNNING',
  NEEDS_INPUT = 'NEEDS_INPUT',
  COMPLETED = 'COMPLETED',
  ERROR = 'ERROR',
}

/**
 * Reasoning budget / effort tiers.
 */
export type BrainpowerLevel = 'low' | 'medium' | 'high' | 'max';

/**
 * Direction when adjusting brainpower via rotary knob.
 */
export type BrainpowerDirection = 'stepUp' | 'stepDown';

/**
 * Decision action for rapid user confirmation.
 */
export type OptionAction = 'ACCEPT' | 'REJECT' | 'ALWAYS_ALLOW';

/**
 * Interactive question prompt and options presented to the user.
 */
export interface SlotQuestion {
  prompt: string;
  options: string[];
}

/**
 * Full state information for an individual peripheral slot (F1 - F12).
 */
export interface SlotInfo {
  /** 1-based slot index (1 to 12) */
  slotIndex: number;
  /** Active session ID, or null/undefined if inactive */
  sessionId?: string | null;
  /** Current agent execution status */
  status: AgentPeripheralStatus;
  /** Current reasoning depth level */
  brainpower?: BrainpowerLevel;
  /** Active tool being executed by the agent */
  activeTool?: string;
  /** Pending user question or confirmation */
  question?: SlotQuestion;
}

/* ========================================================================== */
/*                            JSON-RPC 2.0 Basics                             */
/* ========================================================================== */

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest<TMethod extends string = string, TParams = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: TMethod;
  params?: TParams;
}

export interface JsonRpcNotification<TMethod extends string = string, TParams = unknown> {
  jsonrpc: '2.0';
  method: TMethod;
  params?: TParams;
}

export interface JsonRpcErrorObject<TData = unknown> {
  code: number;
  message: string;
  data?: TData;
}

export interface JsonRpcSuccessResponse<TResult = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result: TResult;
}

export interface JsonRpcErrorResponse<TData = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JsonRpcErrorObject<TData>;
}

export type JsonRpcResponse<TResult = unknown, TData = unknown> =
  | JsonRpcSuccessResponse<TResult>
  | JsonRpcErrorResponse<TData>;

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcResponse;

/* ========================================================================== */
/*                     Server -> Client Notification Payloads                */
/* ========================================================================== */

export interface SnapshotParams {
  focusedSlot: number;
  slots: SlotInfo[];
}

export type SlotUpdatedParams = SlotInfo;

export interface FocusChangedParams {
  focusedSlot: number;
  sessionId: string;
}

export interface ServerShuttingDownParams {
  reason?: string;
}

export type SnapshotNotification = JsonRpcNotification<
  typeof NOTIFICATION_SNAPSHOT,
  SnapshotParams
>;

export type SlotUpdatedNotification = JsonRpcNotification<
  typeof NOTIFICATION_SLOT_UPDATED,
  SlotUpdatedParams
>;

export type FocusChangedNotification = JsonRpcNotification<
  typeof NOTIFICATION_FOCUS_CHANGED,
  FocusChangedParams
>;

export type ServerShuttingDownNotification = JsonRpcNotification<
  typeof NOTIFICATION_SERVER_SHUTTING_DOWN,
  ServerShuttingDownParams
>;

export type ServerNotification =
  | SnapshotNotification
  | SlotUpdatedNotification
  | FocusChangedNotification
  | ServerShuttingDownNotification;

/* ========================================================================== */
/*                     Client -> Server Request/Response Payloads             */
/* ========================================================================== */

export interface SwitchFocusParams {
  slotIndex: number;
}

export interface SwitchFocusResult {
  success: boolean;
  focusedSlot: number;
}

export interface SetBrainpowerParams {
  slotIndex: number;
  direction?: BrainpowerDirection;
  level?: BrainpowerLevel;
}

export interface SetBrainpowerResult {
  success: boolean;
  slotIndex: number;
  brainpower: BrainpowerLevel;
}

export interface SelectOptionParams {
  slotIndex: number;
  optionIndex?: number;
  action: OptionAction;
}

export interface SelectOptionResult {
  success: boolean;
}

export interface AbortParams {
  slotIndex: number;
}

export interface AbortResult {
  success: boolean;
}

export type SwitchFocusRequest = JsonRpcRequest<
  typeof METHOD_SWITCH_FOCUS,
  SwitchFocusParams
>;

export type SetBrainpowerRequest = JsonRpcRequest<
  typeof METHOD_SET_BRAINPOWER,
  SetBrainpowerParams
>;

export type SelectOptionRequest = JsonRpcRequest<
  typeof METHOD_SELECT_OPTION,
  SelectOptionParams
>;

export type AbortRequest = JsonRpcRequest<
  typeof METHOD_ABORT,
  AbortParams
>;

export type ClientRequest =
  | SwitchFocusRequest
  | SetBrainpowerRequest
  | SelectOptionRequest
  | AbortRequest;
