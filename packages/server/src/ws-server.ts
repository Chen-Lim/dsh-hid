import { WebSocketServer, WebSocket } from 'ws';
import {
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_PATH,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
  NOTIFICATION_TRANSPORT_CHANGED,
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
  createTransportChangedNotification,
  serializeJsonRpcMessage,
  isJsonRpcRequest,
  isJsonRpcNotification,
  isValidSlotIndex,
  ProtocolError,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type SlotInfo,
  type BrainpowerDirection,
  type BrainpowerLevel,
  type OptionAction,
  type SnapshotParams,
  type TransportChangedParams,
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
  onTransportChanged?(params: TransportChangedParams): void | Promise<void>;
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
  /** Shared in-flight bind, so a second `start()` joins the first instead of rebinding. */
  private starting: Promise<void> | null = null;

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
    if (this.starting) {
      return this.starting;
    }

    this.starting = this.bind();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * Reclaims the port from a stale DSH process only. Unrelated listeners are left
   * alone: silently `kill -9`ing whatever happens to hold the port would take out
   * unrelated applications.
   */
  private async reclaimPortFromStaleDsh(): Promise<void> {
    if (process.platform !== 'darwin' && process.platform !== 'linux') {
      return;
    }
    if (!this.port || this.port === 0) {
      return;
    }

    const { execSync } = await import('node:child_process');
    const pids = execSync(`lsof -ti:${this.port} -sTCP:LISTEN`, { encoding: 'utf8' })
      .split('\n')
      .map((pid) => pid.trim())
      .filter((pid) => pid.length > 0 && pid !== String(process.pid));

    for (const pid of pids) {
      let commandLine = '';
      try {
        commandLine = execSync(`ps -p ${pid} -o command=`, { encoding: 'utf8' });
      } catch {
        continue;
      }
      if (/DeepSeek Harness|dsh-daemon|dsh-hid/.test(commandLine)) {
        execSync(`kill -9 ${pid} 2>/dev/null || true`, { stdio: 'ignore' });
      } else {
        console.warn(
          `[PeripheralWsServer] Port ${this.port} is held by an unrelated process (${pid}); leaving it untouched.`
        );
      }
    }
  }

  private async bind(): Promise<void> {
    const maxRetries = 3;
    const retryDelayMs = 200;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.reclaimPortFromStaleDsh();
      } catch {
        // Port preflight is best-effort; the bind error handler reports the real failure.
      }

      try {
        await new Promise<void>((resolve, reject) => {
          try {
            const wss = new WebSocketServer({
              host: this.host,
              port: this.port,
              path: this.path,
            });
            this.wss = wss;

            wss.on('listening', () => {
              this.started = true;
              this.setupHeartbeat();
              resolve();
            });

            wss.on('error', (err: any) => {
              if (!this.started) {
                try {
                  wss.close();
                } catch {
                  // ignore
                }
                this.wss = null;
                reject(err);
              } else {
                console.error('[PeripheralWsServer] Server error:', err);
              }
            });

            wss.on('connection', (ws: WebSocket, request) => {
              this.handleConnection(ws as ExtWebSocket, request);
            });
          } catch (err) {
            reject(err);
          }
        });
        return;
      } catch (err: any) {
        if (attempt < maxRetries && err?.code === 'EADDRINUSE') {
          console.warn(
            `[PeripheralWsServer] Port ${this.port} is busy (EADDRINUSE), retrying (${attempt}/${maxRetries}) in ${retryDelayMs}ms...`
          );
          await new Promise((r) => setTimeout(r, retryDelayMs));
          continue;
        }
        throw err;
      }
    }
  }

  private handleConnection(client: ExtWebSocket, request?: { url?: string }): void {
    client.isAlive = true;
    this.activeClients.add(client);

    // In-page consumers connect with `?role=ui`; they must never be mistaken for a
    // hardware daemon by ApprovalArbiter's availability check.
    const isUi = isUiConnection(request?.url);
    if (isUi) {
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

    const handleDisconnect = () => {
      const wasActive = this.activeClients.delete(client);
      this.uiClients.delete(client);
      if (wasActive && !isUi && this.getHardwareClientCount() === 0 && this.handler?.onTransportChanged) {
        void Promise.resolve(
          this.handler.onTransportChanged({
            transport: 'disconnected',
            capabilities: { rgb: false, keys: false, ledBlink: false, wireless: false },
          })
        ).catch((err) => {
          console.error('[PeripheralWsServer] Failed to handle transport disconnect:', err);
        });
      }
    };

    client.on('close', handleDisconnect);

    client.on('error', (err) => {
      console.error('[PeripheralWsServer] Client socket error:', err);
      handleDisconnect();
    });

    // Send initial snapshot on new client connection if available
    if (this.handler?.getInitialSnapshot) {
      try {
        const snapshot = this.handler.getInitialSnapshot();
        const notification = createSnapshotNotification(
          snapshot.focusedSlot,
          snapshot.slots,
          snapshot.transportState
        );
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
    } else if (isJsonRpcNotification(message) && message.method === NOTIFICATION_TRANSPORT_CHANGED) {
      const params = message.params as unknown as TransportChangedParams | undefined;
      if (params && typeof params.transport === 'string' && params.capabilities) {
        await this.handler?.onTransportChanged?.(params);
      }
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

        case NOTIFICATION_TRANSPORT_CHANGED: {
          const transportParams = p as unknown as TransportChangedParams;
          if (!transportParams.transport || !transportParams.capabilities) {
            this.sendToClient(
              client,
              createJsonRpcErrorResponse(id, RPC_INVALID_PARAMS, 'Missing required params: transport, capabilities')
            );
            break;
          }
          await this.handler?.onTransportChanged?.(transportParams);
          this.sendToClient(client, createJsonRpcSuccessResponse(id, { success: true }));
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
    this.pingInterval.unref();
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
  public broadcastSnapshot(
    focusedSlot: number,
    slots: SlotInfo[],
    transportState?: TransportChangedParams
  ): void {
    this.broadcast(createSnapshotNotification(focusedSlot, slots, transportState));
  }

  /**
   * Broadcasts a hardware transport mode change notification.
   */
  public broadcastTransportChanged(params: TransportChangedParams): void {
    this.broadcast(createTransportChangedNotification(params));
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
    if (!this.started && !this.wss) {
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

    const serverToClose = this.wss;
    this.started = false;
    this.wss = null;

    if (!serverToClose) {
      return;
    }

    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      const safetyTimer = setTimeout(done, 1000);
      safetyTimer.unref();

      try {
        serverToClose.close(() => {
          clearTimeout(safetyTimer);
          done();
        });
      } catch {
        clearTimeout(safetyTimer);
        done();
      }
    });
  }
}
