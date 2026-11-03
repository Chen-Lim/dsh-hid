import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('DSH Client Companion Plugin (client.ts)', () => {
  let mockModuleLoader: { load: ReturnType<typeof vi.fn> };
  let originalWindow: unknown;

  beforeEach(() => {
    originalWindow = globalThis.window;
    mockModuleLoader = { load: vi.fn() };
    const listeners: Record<string, ((e: any) => void)[]> = {};
    (globalThis as any).window = {
      __ModuleLoader__: mockModuleLoader,
      addEventListener: vi.fn((event: string, fn: any) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(fn);
      }),
      removeEventListener: vi.fn((event: string, fn: any) => {
        if (listeners[event]) {
          listeners[event] = listeners[event].filter((f) => f !== fn);
        }
      }),
      _listeners: listeners,
    };
  });

  afterEach(() => {
    (globalThis as any).window = originalWindow;
    vi.restoreAllMocks();
  });

  it('builds valid client.js without top-level export statements', () => {
    const clientJsPath = join(__dirname, '../dist/client.js');
    const content = readFileSync(clientJsPath, 'utf8');
    expect(content).toContain('dsh-plugin-peripheral-server');
    expect(content).toContain('__ModuleLoader__');
    expect(content).not.toMatch(/export\s*\{/);
  });

  it('registers with window.__ModuleLoader__ and defines apply with uiWorkspace', () => {
    // Dynamically evaluate client script in global context
    const clientJsPath = join(__dirname, '../dist/client.js');
    const content = readFileSync(clientJsPath, 'utf8');

    // Run within the mock window context
    const fn = new Function('window', content);
    fn((globalThis as any).window);

    expect(mockModuleLoader.load).toHaveBeenCalledTimes(1);
    const reg = mockModuleLoader.load.mock.calls[0][0];
    expect(reg.id).toBe('dsh-plugin-peripheral-server');

    const plugin = reg.factory();
    expect(plugin.inject).toContain('uiWorkspace');
    expect(typeof plugin.apply).toBe('function');
  });

  it('routes focusChanged events to ctx.uiWorkspace.openSession', () => {
    vi.useFakeTimers();
    const clientJsPath = join(__dirname, '../dist/client.js');
    const content = readFileSync(clientJsPath, 'utf8');

    let capturedWs: any = null;
    class MockWebSocket {
      public static OPEN = 1;
      public onopen: any;
      public onmessage: any;
      public onclose: any;
      public onerror: any;
      public readyState = 1;
      public send = vi.fn();
      public close = vi.fn();
      constructor() {
        capturedWs = this;
      }
    }
    (globalThis as any).WebSocket = MockWebSocket;

    const fn = new Function('window', 'WebSocket', content);
    fn((globalThis as any).window, MockWebSocket);

    const plugin = mockModuleLoader.load.mock.calls[0][0].factory();
    const openSessionSpy = vi.fn();
    const mockUiWorkspace = {
      openSession: openSessionSpy,
    };
    const ctx = { uiWorkspace: mockUiWorkspace };

    const cleanup = plugin.apply(ctx);
    expect(capturedWs).not.toBeNull();

    // Simulate incoming peripheral/focusChanged message from daemon/server
    capturedWs.onmessage({
      data: JSON.stringify({
        method: 'peripheral/focusChanged',
        params: { focusedSlot: 1, sessionId: 'session-target-123' },
      }),
    });

    expect(openSessionSpy).toHaveBeenCalledWith('session-target-123');

    // Fast-forward past navigation debounce
    vi.advanceTimersByTime(350);

    // Test hook: when UI calls openSession, sends peripheral/sessionOpened to WebSocket
    mockUiWorkspace.openSession('session-clicked-456');
    expect(capturedWs.send).toHaveBeenCalled();
    const sentData = JSON.parse(capturedWs.send.mock.calls[0][0]);
    expect(sentData.method).toBe('peripheral/sessionOpened');
    expect(sentData.params.sessionId).toBe('session-clicked-456');

    if (typeof cleanup === 'function') cleanup();
    vi.useRealTimers();
  });

  it('registers the resident sidebar entry and its main panel', () => {
    const clientJsPath = join(__dirname, '../dist/client.js');
    const content = readFileSync(clientJsPath, 'utf8');

    class MockWebSocket {
      public static OPEN = 1;
      public onopen: any;
      public onmessage: any;
      public onclose: any;
      public onerror: any;
      public readyState = 1;
      public send = vi.fn();
      public close = vi.fn();
    }
    (globalThis as any).WebSocket = MockWebSocket;

    const fn = new Function('window', 'WebSocket', content);
    fn((globalThis as any).window, MockWebSocket);

    const mockReact = {
      createElement: vi.fn(() => null),
      useState: vi.fn(() => [0, () => {}]),
      useEffect: vi.fn(),
    };
    const plugin = mockModuleLoader.load.mock.calls[0][0].factory((name: string) =>
      name === 'react' ? mockReact : undefined
    );

    const inject = vi.fn((_key: string, register: () => unknown) => {
      register();
      return () => {};
    });
    const register = vi.fn(() => () => {});
    const ctx = {
      uiWorkspace: { openSession: vi.fn() },
      slots: { inject, register },
    };

    const cleanup = plugin.apply(ctx);

    expect(inject).toHaveBeenCalledWith('sidebar.panellist', expect.any(Function));
    expect(inject).toHaveBeenCalledWith('main', expect.any(Function));
    const registeredOptions = register.mock.calls.map((call: any[]) => call[0]);
    expect(registeredOptions).toContainEqual(
      expect.objectContaining({ name: 'sidebar.panellist', id: 'peripheral' })
    );
    expect(registeredOptions).toContainEqual(
      expect.objectContaining({ name: 'main', key: 'peripheral' })
    );

    if (typeof cleanup === 'function') cleanup();
  });

  it('handles physical/virtual keydown for F-keys and approval decisions', () => {
    const clientJsPath = join(__dirname, '../dist/client.js');
    const content = readFileSync(clientJsPath, 'utf8');

    let capturedWs: any = null;
    class MockWebSocket {
      public static OPEN = 1;
      public onopen: any;
      public onmessage: any;
      public onclose: any;
      public onerror: any;
      public readyState = 1;
      public send = vi.fn();
      public close = vi.fn();
      constructor() {
        capturedWs = this;
      }
    }
    (globalThis as any).WebSocket = MockWebSocket;

    const listeners = (globalThis as any).window._listeners;

    const fn = new Function('window', 'WebSocket', content);
    fn((globalThis as any).window, MockWebSocket);

    const plugin = mockModuleLoader.load.mock.calls[0][0].factory();
    const openSessionSpy = vi.fn();
    const mockUiWorkspace = {
      openSession: openSessionSpy,
    };
    const ctx = { uiWorkspace: mockUiWorkspace };

    const cleanup = plugin.apply(ctx);

    // Initial snapshot: Slot 1 is NEEDS_INPUT with session 'session-f1'
    capturedWs.onmessage({
      data: JSON.stringify({
        method: 'peripheral/snapshot',
        params: {
          focusedSlot: 1,
          slots: [
            { slotIndex: 1, sessionId: 'session-f1', status: 'NEEDS_INPUT' },
            { slotIndex: 2, sessionId: 'session-f2', status: 'IDLE' },
          ],
        },
      }),
    });

    const keydownListener = listeners['keydown']?.[0];
    expect(keydownListener).toBeDefined();

    // 1. Press F2 -> switches focus to slot 2 and navigates to session-f2
    const f2Event = {
      key: 'F2',
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    keydownListener(f2Event);
    expect(f2Event.preventDefault).toHaveBeenCalled();
    expect(openSessionSpy).toHaveBeenCalledWith('session-f2');
    const f2Sent = JSON.parse(capturedWs.send.mock.calls.at(-1)[0]);
    expect(f2Sent.method).toBe('peripheral/switchFocus');
    expect(f2Sent.params.slotIndex).toBe(2);

    // Switch focus back to Slot 1 (NEEDS_INPUT)
    capturedWs.onmessage({
      data: JSON.stringify({
        method: 'peripheral/focusChanged',
        params: { focusedSlot: 1, sessionId: 'session-f1' },
      }),
    });

    // 2. Press Enter -> triggers ACCEPT option decision
    const enterEvent = {
      key: 'Enter',
      target: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    keydownListener(enterEvent);
    expect(enterEvent.preventDefault).toHaveBeenCalled();
    const enterSent = JSON.parse(capturedWs.send.mock.calls.at(-1)[0]);
    expect(enterSent.method).toBe('peripheral/selectOption');
    expect(enterSent.params.action).toBe('ACCEPT');
    expect(enterSent.params.slotIndex).toBe(1);

    // 3. Press Escape -> triggers REJECT option decision
    const escEvent = {
      key: 'Escape',
      target: {},
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    keydownListener(escEvent);
    expect(escEvent.preventDefault).toHaveBeenCalled();
    const escSent = JSON.parse(capturedWs.send.mock.calls.at(-1)[0]);
    expect(escSent.method).toBe('peripheral/selectOption');
    expect(escSent.params.action).toBe('REJECT');

    if (typeof cleanup === 'function') cleanup();
  });
});
