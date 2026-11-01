import WebSocket from 'ws';
import {
  DEFAULT_WS_URL,
  NOTIFICATION_SNAPSHOT,
  NOTIFICATION_SLOT_UPDATED,
  NOTIFICATION_FOCUS_CHANGED,
  NOTIFICATION_SERVER_SHUTTING_DOWN,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
  createJsonRpcRequest,
  isJsonRpcNotification,
  isJsonRpcResponse,
  isJsonRpcErrorResponse,
  type SlotInfo,
  type SnapshotNotification,
  type SlotUpdatedNotification,
  type FocusChangedNotification,
  type JsonRpcResponse,
} from '@dsh-hid/protocol';
import type { HardwareAdapter, HardwareEvent } from './adapters/types.js';

export interface DaemonClientOptions {
  /** WebSocket Server URL, default is ws://127.0.0.1:45678/peripheral/v1 */
  url?: string;
  /** Initial reconnection delay in ms, default is 500ms */
  initialReconnectDelayMs?: number;
  /** Max reconnection delay in ms, default is 5000ms */
  maxReconnectDelayMs?: number;
  /** Reconnection backoff multiplier, default is 1.5 */
  backoffMultiplier?: number;
  /** Custom WebSocket factory for testing */
  webSocketFactory?: (url: string) => WebSocket;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: NodeJS.Timeout;
}

/**
 * Daemon client that connects to DSH peripheral WebSocket server,
 * maintains connection with exponential backoff auto-reconnect,
 * synchronizes state to HardwareAdapter, and translates hardware events into JSON-RPC calls.
 */
export class DaemonClient {
  private readonly url: string;
  private readonly adapter: HardwareAdapter;
  private readonly initialDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly backoffMultiplier: number;
  private readonly wsFactory: (url: string) => WebSocket;

  private ws: WebSocket | null = null;
  private running = false;
  private currentDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private unregisterAdapterEvents: (() => void) | null = null;

  private slots: SlotInfo[] = [];
  private focusedSlot = 1;
  private nextRequestId = 1;
  private readonly pendingRequests = new Map<string | number, PendingRequest>();

  constructor(adapter: HardwareAdapter, options: DaemonClientOptions = {}) {
    this.adapter = adapter;
    this.url = options.url ?? DEFAULT_WS_URL;
    this.initialDelayMs = options.initialReconnectDelayMs ?? 500;
    this.maxDelayMs = options.maxReconnectDelayMs ?? 5000;
    this.backoffMultiplier = options.backoffMultiplier ?? 1.5;
    this.currentDelayMs = this.initialDelayMs;
    this.wsFactory = options.webSocketFactory ?? ((url: string) => new WebSocket(url));
  }

  getSlots(): SlotInfo[] {
    return [...this.slots];
  }

  getFocusedSlot(): number {
    return this.focusedSlot;
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Connect hardware adapter
    await this.adapter.connect();

    // Hook hardware events
    this.unregisterAdapterEvents = this.adapter.onEvent((event) => {
      void this.handleHardwareEvent(event);
    });

    // Connect to WebSocket server
    this.connectWs();
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.unregisterAdapterEvents) {
      this.unregisterAdapterEvents();
      this.unregisterAdapterEvents = null;
    }

    // Cancel all pending requests
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Daemon client stopped'));
      this.pendingRequests.delete(id);
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // Safe teardown
      }
      this.ws = null;
    }

    await this.adapter.disconnect();
  }

  private connectWs(): void {
    if (!this.running) return;

    try {
      this.ws = this.wsFactory(this.url);
    } catch {
      this.scheduleReconnect();
      return;
    }

    this.ws.on('open', () => {
      this.currentDelayMs = this.initialDelayMs;
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      this.handleWsMessage(data.toString());
    });

    this.ws.on('close', () => {
      this.ws = null;
      if (this.running) {
        this.scheduleReconnect();
      }
    });

    this.ws.on('error', () => {
      // Handled by close event
    });
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectWs();
    }, this.currentDelayMs);

    this.currentDelayMs = Math.min(this.currentDelayMs * this.backoffMultiplier, this.maxDelayMs);
  }

  private handleWsMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    // Check if notification
    if (isJsonRpcNotification(parsed)) {
      this.handleNotification(parsed);
      return;
    }

    // Check if response to pending request
    if (isJsonRpcResponse(parsed)) {
      this.handleResponse(parsed);
      return;
    }
  }

  private handleNotification(notification: { method: string; params?: unknown }): void {
    switch (notification.method) {
      case NOTIFICATION_SNAPSHOT: {
        const params = (notification as SnapshotNotification).params;
        if (params?.slots) {
          this.slots = [...params.slots];
          this.focusedSlot = params.focusedSlot;
          void this.adapter.renderSlots(this.slots, this.focusedSlot);
        }
        break;
      }
      case NOTIFICATION_SLOT_UPDATED: {
        const slot = (notification as SlotUpdatedNotification).params;
        if (slot && typeof slot.slotIndex === 'number') {
          const idx = this.slots.findIndex((s) => s.slotIndex === slot.slotIndex);
          if (idx !== -1) {
            this.slots[idx] = { ...slot };
          } else {
            this.slots.push({ ...slot });
          }
          void this.adapter.renderSlots(this.slots, this.focusedSlot);
        }
        break;
      }
      case NOTIFICATION_FOCUS_CHANGED: {
        const params = (notification as FocusChangedNotification).params;
        if (params?.focusedSlot) {
          this.focusedSlot = params.focusedSlot;
          void this.adapter.renderSlots(this.slots, this.focusedSlot);
        }
        break;
      }
      case NOTIFICATION_SERVER_SHUTTING_DOWN: {
        this.slots = [];
        void this.adapter.renderSlots(this.slots, this.focusedSlot);
        break;
      }
    }
  }

  private handleResponse(response: JsonRpcResponse): void {
    if (response.id === null || response.id === undefined) return;
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timer);
    this.pendingRequests.delete(response.id);

    if (isJsonRpcErrorResponse(response)) {
      pending.reject(new Error(`JSON-RPC Error [${response.error.code}]: ${response.error.message}`));
    } else {
      pending.resolve(response.result);
    }
  }

  /**
   * Send a JSON-RPC request to the server and await result.
   */
  async sendRequest<TResult = unknown>(method: string, params?: unknown, timeoutMs = 5000): Promise<TResult> {
    if (!this.isConnected()) {
      throw new Error(`Cannot send request '${method}': DaemonClient is not connected to server`);
    }

    const id = this.nextRequestId++;
    const message = createJsonRpcRequest(id, method, params);

    return new Promise<TResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      this.ws?.send(JSON.stringify(message));
    });
  }

  private async handleHardwareEvent(event: HardwareEvent): Promise<void> {
    if (!this.isConnected()) return;

    try {
      switch (event.type) {
        case 'switchFocus': {
          await this.sendRequest(METHOD_SWITCH_FOCUS, { slotIndex: event.slotIndex });
          break;
        }
        case 'knob': {
          if (event.action === 'stepUp' || event.action === 'stepDown') {
            await this.sendRequest(METHOD_SET_BRAINPOWER, {
              slotIndex: this.focusedSlot,
              direction: event.action,
            });
          }
          break;
        }
        case 'option': {
          const slot = this.slots.find((s) => s.slotIndex === this.focusedSlot);
          let optionIndex = 0;
          if (slot?.question?.options) {
            const found = slot.question.options.indexOf(event.action);
            if (found !== -1) optionIndex = found;
          }
          await this.sendRequest(METHOD_SELECT_OPTION, {
            slotIndex: this.focusedSlot,
            optionIndex,
            action: event.action,
          });
          break;
        }
        case 'abort': {
          await this.sendRequest(METHOD_ABORT, {
            slotIndex: this.focusedSlot,
          });
          break;
        }
      }
    } catch (err) {
      // Safe dispatch, logs without crashing daemon
      console.error('[DaemonClient] Error executing hardware event action:', err);
    }
  }
}
