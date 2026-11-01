import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import {
  AgentPeripheralStatus,
  METHOD_SWITCH_FOCUS,
  METHOD_SET_BRAINPOWER,
  METHOD_SELECT_OPTION,
  METHOD_ABORT,
  NOTIFICATION_SNAPSHOT,
  NOTIFICATION_SLOT_UPDATED,
  NOTIFICATION_FOCUS_CHANGED,
  createJsonRpcRequest,
  parseJsonRpcMessage,
  isJsonRpcSuccessResponse,
  isJsonRpcErrorResponse,
  isJsonRpcNotification,
  type SlotInfo,
} from '@dsh-hid/protocol';
import { PeripheralWsServer, type PeripheralRpcHandler } from '../src/ws-server.js';

class TestClient {
  private queue: any[] = [];
  private waiters: ((msg: any) => void)[] = [];
  public ws: WebSocket;

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data) => {
      const parsed = parseJsonRpcMessage(data.toString('utf-8'));
      if (this.waiters.length > 0) {
        const waiter = this.waiters.shift()!;
        waiter(parsed);
      } else {
        this.queue.push(parsed);
      }
    });
  }

  async waitForOpen(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return;
    return new Promise((resolve, reject) => {
      this.ws.once('open', () => resolve());
      this.ws.once('error', reject);
    });
  }

  nextMessage(timeoutMs: number = 2000): Promise<any> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift());
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Timeout waiting for message after ${timeoutMs}ms`));
      }, timeoutMs);

      this.waiters.push((msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }

  send(obj: any): void {
    this.ws.send(JSON.stringify(obj));
  }

  close(): void {
    try {
      this.ws.terminate();
    } catch {
      // ignore
    }
  }
}

describe('PeripheralWsServer', () => {
  let server: PeripheralWsServer;
  let client: TestClient | null = null;

  const mockSlots: SlotInfo[] = [
    {
      slotIndex: 1,
      sessionId: 'sess-1',
      status: AgentPeripheralStatus.RUNNING,
      brainpower: 'high',
    },
    {
      slotIndex: 2,
      sessionId: null,
      status: AgentPeripheralStatus.INACTIVE,
    },
  ];

  const handler: PeripheralRpcHandler = {
    getInitialSnapshot: vi.fn(() => ({
      focusedSlot: 1,
      slots: mockSlots,
    })),
    onSwitchFocus: vi.fn(async (slotIndex) => ({
      success: true,
      focusedSlot: slotIndex,
    })),
    onSetBrainpower: vi.fn(async (slotIndex, direction, level) => ({
      success: true,
      slotIndex,
      brainpower: level ?? 'max',
    })),
    onSelectOption: vi.fn(async (slotIndex, optionIndex, action) => ({
      success: true,
      slotIndex,
    })),
    onAbort: vi.fn(async (slotIndex) => ({
      success: true,
      slotIndex,
    })),
  };

  beforeEach(async () => {
    server = new PeripheralWsServer({
      host: '127.0.0.1',
      port: 0, // dynamic free port
      path: '/peripheral/v1',
      handler,
      heartbeatIntervalMs: 1000,
    });
    await server.start();
  });

  afterEach(async () => {
    if (client) {
      client.close();
      client = null;
    }
    await server.close();
  });

  async function createConnectedClient(): Promise<TestClient> {
    const url = `ws://127.0.0.1:${server.getPort()}/peripheral/v1`;
    const tc = new TestClient(url);
    await tc.waitForOpen();
    return tc;
  }

  it('receives initial snapshot notification upon connecting', async () => {
    client = await createConnectedClient();
    const msg = await client.nextMessage();

    expect(isJsonRpcNotification(msg)).toBe(true);
    expect(msg.method).toBe(NOTIFICATION_SNAPSHOT);
    expect(msg.params.focusedSlot).toBe(1);
    expect(msg.params.slots).toHaveLength(2);
  });

  it('handles peripheral/switchFocus request', async () => {
    client = await createConnectedClient();
    await client.nextMessage(); // consume snapshot

    const req = createJsonRpcRequest(101, METHOD_SWITCH_FOCUS, { slotIndex: 2 });
    client.send(req);

    const res = await client.nextMessage();
    expect(isJsonRpcSuccessResponse(res)).toBe(true);
    expect(res.id).toBe(101);
    expect(res.result).toEqual({ success: true, focusedSlot: 2 });
    expect(handler.onSwitchFocus).toHaveBeenCalledWith(2);
  });

  it('handles peripheral/setBrainpower request', async () => {
    client = await createConnectedClient();
    await client.nextMessage();

    const req = createJsonRpcRequest(102, METHOD_SET_BRAINPOWER, {
      slotIndex: 1,
      direction: 'stepUp',
      level: 'max',
    });
    client.send(req);

    const res = await client.nextMessage();
    expect(isJsonRpcSuccessResponse(res)).toBe(true);
    expect(res.id).toBe(102);
    expect(res.result).toEqual({ success: true, slotIndex: 1, brainpower: 'max' });
  });

  it('handles peripheral/selectOption and peripheral/abort', async () => {
    client = await createConnectedClient();
    await client.nextMessage();

    // Option
    const optReq = createJsonRpcRequest(103, METHOD_SELECT_OPTION, {
      slotIndex: 1,
      optionIndex: 0,
      action: 'ACCEPT',
    });
    client.send(optReq);
    const optRes = await client.nextMessage();
    expect(isJsonRpcSuccessResponse(optRes)).toBe(true);
    expect(optRes.result).toEqual({ success: true, slotIndex: 1 });

    // Abort
    const abortReq = createJsonRpcRequest(104, METHOD_ABORT, { slotIndex: 1 });
    client.send(abortReq);
    const abortRes = await client.nextMessage();
    expect(isJsonRpcSuccessResponse(abortRes)).toBe(true);
    expect(abortRes.result).toEqual({ success: true, slotIndex: 1 });
  });

  it('returns invalid params error on out of range slot', async () => {
    client = await createConnectedClient();
    await client.nextMessage();

    const req = createJsonRpcRequest(999, METHOD_SWITCH_FOCUS, { slotIndex: 99 });
    client.send(req);

    const res = await client.nextMessage();
    expect(isJsonRpcErrorResponse(res)).toBe(true);
    expect(res.error.code).toBe(-32602);
  });

  it('broadcasts slotUpdated and focusChanged notifications to clients', async () => {
    client = await createConnectedClient();
    await client.nextMessage();

    const updatedSlot: SlotInfo = {
      slotIndex: 1,
      sessionId: 'sess-1',
      status: AgentPeripheralStatus.NEEDS_INPUT,
      question: { prompt: 'Confirm?', options: ['Yes', 'No'] },
    };

    server.broadcastSlotUpdated(updatedSlot);
    const notif1 = await client.nextMessage();
    expect(isJsonRpcNotification(notif1)).toBe(true);
    expect(notif1.method).toBe(NOTIFICATION_SLOT_UPDATED);
    expect(notif1.params.status).toBe(AgentPeripheralStatus.NEEDS_INPUT);

    server.broadcastFocusChanged(2, 'sess-2');
    const notif2 = await client.nextMessage();
    expect(isJsonRpcNotification(notif2)).toBe(true);
    expect(notif2.method).toBe(NOTIFICATION_FOCUS_CHANGED);
    expect(notif2.params).toEqual({ focusedSlot: 2, sessionId: 'sess-2' });
  });
});
