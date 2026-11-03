import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('DSH Client Companion Plugin (client.ts)', () => {
  let mockModuleLoader: { load: ReturnType<typeof vi.fn> };
  let originalWindow: unknown;

  beforeEach(() => {
    originalWindow = globalThis.window;
    mockModuleLoader = { load: vi.fn() };
    (globalThis as any).window = {
      __ModuleLoader__: mockModuleLoader,
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
});
