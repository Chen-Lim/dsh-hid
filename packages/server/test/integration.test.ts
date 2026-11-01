import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Context } from 'cordis';
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
  isJsonRpcNotification,
  type SnapshotParams,
} from '@dsh-hid/protocol';
import { PeripheralServerService } from '../src/service.js';

class IntegrationClient {
  private queue: any[] = [];
  private waiters: ((msg: any) => void)[] = [];
  public notifications: any[] = [];
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

  nextMessage(timeoutMs: number = 3000): Promise<any> {
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

  /**
   * Sends a request and filters through incoming messages until matching response ID arrives.
   */
  async request(method: string, params?: any, id: number = 1000 + Math.floor(Math.random() * 9000)): Promise<any> {
    const req = createJsonRpcRequest(id, method, params);
    this.ws.send(JSON.stringify(req));

    const startTime = Date.now();
    while (Date.now() - startTime < 3000) {
      const msg = await this.nextMessage();
      if ('id' in msg && msg.id === id) {
        return msg;
      }
      this.notifications.push(msg);
    }
    throw new Error(`Timeout waiting for response to request ${id} (${method})`);
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

describe('End-to-End Peripheral Server Integration', () => {
  let ctx: Context;
  let service: PeripheralServerService;
  let client: IntegrationClient | null = null;

  beforeEach(async () => {
    ctx = new Context();
    service = new PeripheralServerService(ctx, {
      port: 0,
      autoBindSlots: true,
    });
    await service.start();
  });

  afterEach(async () => {
    if (client) {
      client.close();
      client = null;
    }
    await service.stop();
  });

  async function createClient(): Promise<IntegrationClient> {
    const port = service.wsServer.getPort();
    const c = new IntegrationClient(`ws://127.0.0.1:${port}/peripheral/v1`);
    await c.waitForOpen();
    return c;
  }

  it('receives full snapshot on initial connection', async () => {
    // Pre-create an agent session before client connects
    ctx.emit('agent/created', 'session-existing');
    ctx.emit('agent/status', 'session-existing', 'running');

    client = await createClient();
    const snapshotMsg = await client.nextMessage();

    expect(isJsonRpcNotification(snapshotMsg)).toBe(true);
    expect(snapshotMsg.method).toBe(NOTIFICATION_SNAPSHOT);

    const snapshot = snapshotMsg.params as SnapshotParams;
    expect(snapshot.focusedSlot).toBe(1);
    expect(snapshot.slots[0].sessionId).toBe('session-existing');
    expect(snapshot.slots[0].status).toBe(AgentPeripheralStatus.RUNNING);
  });

  it('streams agent lifecycle events in real-time to peripheral daemon', async () => {
    client = await createClient();
    await client.nextMessage(); // consume snapshot

    // 1. Agent created
    ctx.emit('agent/created', 'sess-agent-1');
    const createdMsg = await client.nextMessage();
    expect(isJsonRpcNotification(createdMsg)).toBe(true);
    expect(createdMsg.method).toBe(NOTIFICATION_SLOT_UPDATED);
    expect(createdMsg.params.sessionId).toBe('sess-agent-1');
    expect(createdMsg.params.status).toBe(AgentPeripheralStatus.IDLE);

    // 2. Agent begins executing tool
    ctx.emit('agent/status', 'sess-agent-1', 'running');
    const runningMsg = await client.nextMessage();
    expect(runningMsg.params.status).toBe(AgentPeripheralStatus.RUNNING);

    ctx.emit('agent/tool-start', 'sess-agent-1', 'bash');
    const toolMsg = await client.nextMessage();
    expect(toolMsg.params.activeTool).toBe('bash');

    // 3. Agent hits Human-In-The-Loop question
    ctx.emit('interaction/user-questions', 'sess-agent-1', {
      prompt: 'Execute high-risk bash command?',
      options: ['Proceed', 'Cancel'],
    });
    const hitlMsg = await client.nextMessage();
    expect(hitlMsg.params.status).toBe(AgentPeripheralStatus.NEEDS_INPUT);
    expect(hitlMsg.params.question.options).toContain('Proceed');

    // 4. Agent completed
    ctx.emit('agent/status', 'sess-agent-1', 'completed');
    const doneMsg = await client.nextMessage();
    expect(doneMsg.params.status).toBe(AgentPeripheralStatus.COMPLETED);

    // 5. Agent disposed
    ctx.emit('agent/disposed', 'sess-agent-1');
    const disposedMsg = await client.nextMessage();
    expect(disposedMsg.params.status).toBe(AgentPeripheralStatus.INACTIVE);
    expect(disposedMsg.params.sessionId).toBeNull();
  });

  it('dispatches client switchFocus request and updates both router and DSH event bus', async () => {
    ctx.emit('agent/created', 'sess-slot-1');
    ctx.emit('agent/created', 'sess-slot-2');

    client = await createClient();
    await client.nextMessage(); // snapshot

    const focusListener = vi.fn();
    ctx.on('peripheral/focus-switched', focusListener);

    // Send switchFocus to slot 2 via request helper
    const res = await client.request(METHOD_SWITCH_FOCUS, { slotIndex: 2 }, 2001);
    expect(isJsonRpcSuccessResponse(res)).toBe(true);
    expect(res.result).toEqual({ success: true, focusedSlot: 2 });

    expect(focusListener).toHaveBeenCalledWith(2, 'sess-slot-2');

    // The focus change notification was collected
    const focusNotification = client.notifications.find((n) => n.method === NOTIFICATION_FOCUS_CHANGED);
    expect(focusNotification).toBeDefined();
    expect(focusNotification.params).toEqual({ focusedSlot: 2, sessionId: 'sess-slot-2' });
  });

  it('adjusts brainpower stepwise via rotary knob instruction', async () => {
    ctx.emit('agent/created', 'sess-knob');
    client = await createClient();
    await client.nextMessage();

    const brainpowerListener = vi.fn();
    ctx.on('peripheral/brainpower-changed', brainpowerListener);

    // Step up from 'medium' to 'high'
    const res1 = await client.request(METHOD_SET_BRAINPOWER, {
      slotIndex: 1,
      direction: 'stepUp',
    }, 2002);
    expect(isJsonRpcSuccessResponse(res1)).toBe(true);
    expect(res1.result.brainpower).toBe('high');

    // Step up from 'high' to 'max'
    const res2 = await client.request(METHOD_SET_BRAINPOWER, {
      slotIndex: 1,
      direction: 'stepUp',
    }, 2003);
    expect(isJsonRpcSuccessResponse(res2)).toBe(true);
    expect(res2.result.brainpower).toBe('max');

    // Step down from 'max' to 'high'
    const res3 = await client.request(METHOD_SET_BRAINPOWER, {
      slotIndex: 1,
      direction: 'stepDown',
    }, 2004);
    expect(isJsonRpcSuccessResponse(res3)).toBe(true);
    expect(res3.result.brainpower).toBe('high');

    expect(brainpowerListener).toHaveBeenCalledTimes(3);
  });

  it('resolves HITL approval via selectOption and marks slot running', async () => {
    ctx.emit('agent/created', 'sess-hitl-flow');
    ctx.emit('interaction/user-questions', 'sess-hitl-flow', {
      prompt: 'Confirm destructive action?',
      options: ['Yes, proceed', 'No, cancel'],
    });

    client = await createClient();
    await client.nextMessage();

    const optionListener = vi.fn();
    ctx.on('peripheral/option-selected', optionListener);

    // Physical key pressed for option 0 (Proceed)
    const res = await client.request(METHOD_SELECT_OPTION, {
      slotIndex: 1,
      optionIndex: 0,
      action: 'ACCEPT',
    }, 2005);
    expect(isJsonRpcSuccessResponse(res)).toBe(true);
    expect(optionListener).toHaveBeenCalledWith(1, 0, 'ACCEPT', 'sess-hitl-flow');

    // Router should automatically clear the question and return to running
    const updatedSlot = service.router.getSlot(1);
    expect(updatedSlot?.status).toBe(AgentPeripheralStatus.RUNNING);
    expect(updatedSlot?.question).toBeUndefined();
  });

  it('aborts active task via emergency abort instruction', async () => {
    ctx.emit('agent/created', 'sess-abort-flow');
    ctx.emit('agent/status', 'sess-abort-flow', 'running');

    client = await createClient();
    await client.nextMessage();

    const abortListener = vi.fn();
    ctx.on('peripheral/abort-requested', abortListener);

    const res = await client.request(METHOD_ABORT, { slotIndex: 1 }, 2006);
    expect(isJsonRpcSuccessResponse(res)).toBe(true);
    expect(abortListener).toHaveBeenCalledWith(1, 'sess-abort-flow');

    const updatedSlot = service.router.getSlot(1);
    expect(updatedSlot?.status).toBe(AgentPeripheralStatus.ERROR);
  });
});
