import { WebSocketServer, WebSocket } from 'ws';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PATH,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
  RPC_METHOD_NOT_FOUND,
  RPC_INVALID_PARAMS,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_REQUEST,
  parseJsonRpcMessage,
  createJsonRpcSuccessResponse,
  createJsonRpcErrorResponse,
  createSnapshotNotification,
  createSlotUpdatedNotification,
  createFocusChangedNotification,
  createServerShuttingDownNotification,
  serializeJsonRpcMessage,
  isJsonRpcRequest,
  isValidSlotIndex,
  ProtocolError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type SlotInfo,
  type BrainpowerDirection,
  type BrainpowerLevel,
  type OptionAction,
  type SnapshotParams,
} from '@dsh-hid/protocol';

export interface PeripheralRpcHandler {
  onSwitchFocus?(slotIndex: number): Promise<{ success: boolean; focusedSlot: number }>;
  onSetBrainpower?(
    slotIndex: number,
    direction?: BrainpowerDirection,
    level?: BrainpowerLevel
  ): Promise<{ success: boolean; slotIndex: number; brainpower: BrainpowerLevel }>;
  onSelectOption?(
    slotIndex: number,
    optionIndex: number,
    action: OptionAction
  ): Promise<{ success: boolean; slotIndex: number }>;
  onAbort?(slotIndex: number): Promise<{ success: boolean; slotIndex: number }>;
  onSessionOpened?(sessionId: string): Promise<{ success: boolean; slotIndex?: number }>;
  getInitialSnapshot?(): SnapshotParams;
}

export interface PeripheralWsServerOptions {
  host?: string;
  port?: number;
  path?: string;
  handler?: PeripheralRpcHandler;
  heartbeatIntervalMs?: number;
}

interface ExtWebSocket extends WebSocket {
  isAlive: boolean;
}

/** In-page UI consumers advertise `?role=ui`; every other connection is a hardware daemon. */
function isUiConnection(url: string | undefined): boolean {
  if (!url) return false;
  const queryIndex = url.indexOf('?');
  if (queryIndex < 0) return false;
  const params = new URLSearchParams(url.slice(queryIndex + 1));
  return params.get('role') === 'ui';
}

/**
 * WebSocket server that exposes the JSON-RPC 2.0 peripheral bridge interface.
 */
export class PeripheralWsServer {
  private readonly host: string;
  private readonly port: number;
  private readonly path: string;
  private readonly handler?: PeripheralRpcHandler;
  private readonly heartbeatIntervalMs: number;

  private wss: WebSocketServer | null = null;
  private pingInterval: NodeJS.Timeout | null = null;
  private activeClients: Set<ExtWebSocket> = new Set();
  private uiClients: Set<ExtWebSocket> = new Set();
  private started: boolean = false;

  constructor(options?: PeripheralWsServerOptions) {
    this.host = options?.host ?? DEFAULT_HOST;
    this.port = options?.port ?? DEFAULT_PORT;
    this.path = options?.path ?? DEFAULT_PATH;
    this.handler = options?.handler;
    this.heartbeatIntervalMs = options?.heartbeatIntervalMs ?? 30000;
  }

  /**
   * Starts the WebSocket server listening on the loopback address.
   */
  public async start(): Promise<void> {
    if (this.started) {
      return;
    }

    if (process.platform === 'darwin' || process.platform === 'linux') {
      try {
        const { execSync } = await import('node:child_process');
        execSync(`lsof -ti:${this.port} | grep -v "^${process.pid}$" | xargs kill -9 2>/dev/null || true`, {
          stdio: 'ignore',
        });
      } catch {
        // ignore
      }
    }

    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({
          host: this.host,
          port: this.port,
          path: this.path,
        });

        this.wss.on('listening', () => {
          this.started = true;
          this.setupHeartbeat();
          resolve();
        });

        this.wss.on('error', (err) => {
          if (!this.started) {
            reject(err);
          } else {
            console.error('[PeripheralWsServer] Server error:', err);
          }
        });

        this.wss.on('connection', (ws: WebSocket, request) => {
          this.handleConnection(ws as ExtWebSocket, request);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private handleConnection(client: ExtWebSocket, request?: { url?: string }): void {
    client.isAlive = true;
    this.activeClients.add(client);

    // In-page consumers connect with `?role=ui`; they must never be mistaken for a
    // hardware daemon by ApprovalArbiter's availability check.
    if (isUiConnection(request?.url)) {
      this.uiClients.add(client);
    }

    client.on('pong', () => {
      client.isAlive = true;
    });

    client.on('message', async (data) => {
      try {
        const raw = data.toString('utf-8');
        await this.handleClientMessage(client, raw);
      } catch (err) {
        console.error('[PeripheralWsServer] Failed to handle message:', err);
      }
    });

    client.on('close', () => {
      this.activeClients.delete(client);
      this.uiClients.delete(client);
    });

    client.on('error', (err) => {
      console.error('[PeripheralWsServer] Client socket error:', err);
      this.activeClients.delete(client);
      this.uiClients.delete(client);
    });

    // Send initial snapshot on new client connection if available
    if (this.handler?.getInitialSnapshot) {
      try {
        const snapshot = this.handler.getInitialSnapshot();
        const notification = createSnapshotNotification(snapshot.focusedSlot, snapshot.slots);
        this.sendToClient(client, notification);
      } catch (err) {
        console.error('[PeripheralWsServer] Failed to send initial snapshot:', err);
      }
    }
  }

  private async handleClientMessage(client: ExtWebSocket, raw: string): Promise<void> {
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(raw);
    } catch (err) {
      const code = err instanceof ProtocolError ? err.code : RPC_INVALID_REQUEST;
      const response = createJsonRpcErrorResponse(null, code, (err as Error).message);
      this.sendToClient(client, response);
      return;
    }

    if (isJsonRpcRequest(message)) {
      await this.dispatchRequest(client, message);
    }
  }

  private async dispatchRequest(client: ExtWebSocket, req: JsonRpcRequest): Promise<void> {
    const { id, method, params } = req;
    const p = (params ?? {}) as Record<string, unknown>;

    try {
      switch (method) {
        case METHOD_SWITCH_FOCUS: {
          if (!this.handler?.onSwitchFocus) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_METHOD_NOT_FOUND, `Method ${method} not implemented`)
            );
            return;
          }
          const slotIndex = p.slotIndex;
          if (!isValidSlotIndex(slotIndex)) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_INVALID_PARAMS, 'slotIndex must be between 1 and 12')
            );
            return;
          }
          const result = await this.handler.onSwitchFocus(slotIndex);
          this.sendToClient(client, createJsonRpcSuccessResponse(id, result));
          break;
        }

        case METHOD_SET_BRAINPOWER: {
          if (!this.handler?.onSetBrainpower) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_METHOD_NOT_FOUND, `Method ${method} not implemented`)
            );
            return;
          }
          const slotIndex = p.slotIndex;
          if (!isValidSlotIndex(slotIndex)) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_INVALID_PARAMS, 'slotIndex must be between 1 and 12')
            );
            return;
          }
          const direction = p.direction as BrainpowerDirection | undefined;
          const level = p.level as BrainpowerLevel | undefined;
          const result = await this.handler.onSetBrainpower(slotIndex, direction, level);
          this.sendToClient(client, createJsonRpcSuccessResponse(id, result));
          break;
        }

        case METHOD_SELECT_OPTION: {
          if (!this.handler?.onSelectOption) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_METHOD_NOT_FOUND, `Method ${method} not implemented`)
            );
            return;
          }
          const slotIndex = p.slotIndex;
          const optionIndex = p.optionIndex;
          const action = p.action as OptionAction;
          if (!isValidSlotIndex(slotIndex) || typeof optionIndex !== 'number' || !action) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(
                id,
                RPC_INVALID_PARAMS,
                'Invalid params for peripheral/selectOption: slotIndex, optionIndex, action are required'
              )
            );
            return;
          }
          const result = await this.handler.onSelectOption(slotIndex, optionIndex, action);
          this.sendToClient(client, createJsonRpcSuccessResponse(id, result));
          break;
        }

        case METHOD_ABORT: {
          if (!this.handler?.onAbort) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_METHOD_NOT_FOUND, `Method ${method} not implemented`)
            );
            return;
          }
          const slotIndex = p.slotIndex;
          if (!isValidSlotIndex(slotIndex)) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_INVALID_PARAMS, 'slotIndex must be between 1 and 12')
            );
            return;
          }
          const result = await this.handler.onAbort(slotIndex);
          this.sendToClient(client, createJsonRpcSuccessResponse(id, result));
          break;
        }

        case 'peripheral/sessionOpened': {
          const sessionId = p.sessionId as string;
          if (!sessionId) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_INVALID_PARAMS, 'Missing required param: sessionId')
            );
            break;
          }
          if (this.handler?.onSessionOpened) {
            const result = await this.handler.onSessionOpened(sessionId);
            this.sendToClient(client, createJsonRpcSuccessResponse(id, result));
          } else {
            this.sendToClient(client, createJsonRpcSuccessResponse(id, { success: true }));
          }
          break;
        }

        default: {
          this.sendToClient(
            client,
            createJsonRpcErrorResponse(id, RPC_METHOD_NOT_FOUND, `Unknown method: ${method}`)
          );
          break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendToClient(client, createJsonRpcErrorResponse(id, RPC_INTERNAL_ERROR, message));
    }
  }

  private sendToClient(client: ExtWebSocket, msg: JsonRpcMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      const payload = serializeJsonRpcMessage(msg);
      client.send(payload);
    }
  }

  private setupHeartbeat(): void {
    if (this.heartbeatIntervalMs <= 0) return;

    this.pingInterval = setInterval(() => {
      for (const client of this.activeClients) {
        if (!client.isAlive) {
          client.terminate();
          this.activeClients.delete(client);
        } else {
          client.isAlive = false;
          client.ping();
        }
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Broadcasts a JSON-RPC notification or message to all connected clients.
   */
  public broadcast(msg: JsonRpcMessage): void {
    const serialized = serializeJsonRpcMessage(msg);
    for (const client of this.activeClients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    }
  }

  /**
   * Broadcasts full snapshot to all connected clients.
   */
  public broadcastSnapshot(focusedSlot: number, slots: SlotInfo[]): void {
    this.broadcast(createSnapshotNotification(focusedSlot, slots));
  }

  /**
   * Broadcasts a slot update event.
   */
  public broadcastSlotUpdated(slot: SlotInfo): void {
    this.broadcast(createSlotUpdatedNotification(slot));
  }

  /**
   * Broadcasts a focus changed event.
   */
  public broadcastFocusChanged(focusedSlot: number, sessionId: string): void {
    this.broadcast(createFocusChangedNotification(focusedSlot, sessionId));
  }

  /**
   * Broadcasts server shutting down signal.
   */
  public broadcastShuttingDown(reason?: string): void {
    this.broadcast(createServerShuttingDownNotification(reason));
  }

  /**
   * Returns the count of connected active clients.
   */
  public getClientCount(): number {
    return this.activeClients.size;
  }

  /**
   * Returns the count of connected hardware daemons (UI_role connections excluded).
   */
  public getHardwareClientCount(): number {
    return this.activeClients.size - this.uiClients.size;
  }

  /**
   * Returns the count of connected in-page UI consumers.
   */
  public getUiClientCount(): number {
    return this.uiClients.size;
  }

  /**
   * Returns whether the server is running.
   */
  public isRunning(): boolean {
    return this.started;
  }

  /**
   * Returns the bound port number.
   */
  public getPort(): number {
    const addr = this.wss?.address();
    if (addr && typeof addr === 'object') {
      return addr.port;
    }
    return this.port;
  }

  /**
   * Gracefully shuts down the WebSocket server.
   */
  public async close(): Promise<void> {
    if (!this.started || !this.wss) {
      return;
    }

    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }

    // Broadcast shutdown notification
    try {
      this.broadcastShuttingDown('Server is disposing');
    } catch {
      // ignore
    }

    // Terminate active client sockets immediately to avoid hanging
    for (const client of this.activeClients) {
      try {
        client.terminate();
      } catch {
        // ignore
      }
    }
    this.activeClients.clear();
    this.uiClients.clear();

    return new Promise((resolve) => {
      this.wss?.close(() => {
        this.started = false;
        this.wss = null;
        resolve();
      });
    });
  }
}
