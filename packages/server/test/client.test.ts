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

  it('renders transport badge, Bluetooth fallback notice, and plays chime on NEEDS_INPUT in Bluetooth mode', () => {
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

    const oscStart = vi.fn();
    const oscStop = vi.fn();
    (globalThis as any).window.AudioContext = class {
      public currentTime = 0;
      public destination = {};
      createOscillator() {
        return {
          type: 'sine',
          frequency: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          start: oscStart,
          stop: oscStop,
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
          connect: vi.fn(),
        };
      }
    };

    const fn = new Function('window', 'WebSocket', content);
    fn((globalThis as any).window, MockWebSocket);

    const renderedElements: Array<{ type: any; props: any; children: any[] }> = [];
    const mockReact = {
      createElement: vi.fn((type: any, props: any, ...children: any[]) => {
        const el = { type, props, children };
        renderedElements.push(el);
        return el;
      }),
      useState: vi.fn(() => [0, () => {}]),
      useEffect: vi.fn(),
    };

    const plugin = mockModuleLoader.load.mock.calls[0][0].factory((name: string) =>
      name === 'react' ? mockReact : undefined
    );

    let panelComponent: (() => any) | null = null;
    const inject = vi.fn((_key: string, register: () => unknown) => {
      register();
      return () => {};
    });
    const register = vi.fn((meta: any, comp: any) => {
      if (meta.name === 'main' && meta.key === 'peripheral') {
        panelComponent = comp;
      }
      return () => {};
    });

    const cleanup = plugin.apply({
      uiWorkspace: { openSession: vi.fn() },
      slots: { inject, register },
    });

    expect(panelComponent).not.toBeNull();

    // Send snapshot + Bluetooth transportChanged
    capturedWs.onmessage({
      data: JSON.stringify({
        method: 'peripheral/snapshot',
        params: {
          focusedSlot: 1,
          slots: [{ slotIndex: 1, sessionId: 'sess-bt', status: 'RUNNING' }],
        },
      }),
    });
    capturedWs.onmessage({
      data: JSON.stringify({
        method: 'peripheral/transportChanged',
        params: {
          transport: 'bluetooth',
          model: 'NuPhy Air75 V3',
          capabilities: { rgb: false, keys: true, ledBlink: true, wireless: true },
        },
      }),
    });

    renderedElements.length = 0;
    panelComponent!();

    const badge = renderedElements.find(
      (el) => el.props && el.props['data-testid'] === 'peripheral-transport-badge'
    );
    expect(badge).toBeDefined();
    expect(badge?.children[0]).toContain('NuPhy Air75 V3');
    expect(badge?.children[0]).toContain('Bluetooth (Keys Only)');

    const notice = renderedElements.find(
      (el) => el.props && el.props['data-testid'] === 'peripheral-bluetooth-notice'
    );
    expect(notice).toBeDefined();
    expect(notice?.children[0]).toContain('Bluetooth mode active');

    // Transition slot 1 from RUNNING -> NEEDS_INPUT while in Bluetooth mode -> plays chime
    capturedWs.onmessage({
      data: JSON.stringify({
        method: 'peripheral/slotUpdated',
        params: {
          slotIndex: 1,
          sessionId: 'sess-bt',
          status: 'NEEDS_INPUT',
        },
      }),
    });
    expect(oscStart).toHaveBeenCalledTimes(1);

    if (typeof cleanup === 'function') cleanup();
  });

  it('registers dictionaries with ctx.locale and reacts to locale switching', () => {
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

    let activeLocale = 'zh';
    let localeSubscriber: (() => void) | null = null;
    const registerSpy = vi.fn();
    const mockLocale = {
      register: registerSpy.mockImplementation((_ns: string, _lang: string, _dict: any) => () => {}),
      bind: vi.fn((_ns: string) => (key: string) => {
        if (activeLocale === 'en') {
          return key === 'title' ? 'Peripheral' : key;
        }
        return key === 'title' ? '外设' : key;
      }),
      subscribe: vi.fn((cb: () => void) => {
        localeSubscriber = cb;
        return () => {
          localeSubscriber = null;
        };
      }),
    };

    const inject = vi.fn((_key: string, reg: () => unknown) => {
      reg();
      return () => {};
    });
    const register = vi.fn(() => () => {});

    const mockReact = {
      createElement: vi.fn(() => null),
      useState: vi.fn(() => [0, () => {}]),
      useEffect: vi.fn(),
    };

    const plugin = mockModuleLoader.load.mock.calls[0][0].factory((name: string) =>
      name === 'react' ? mockReact : undefined
    );
    const ctx = {
      locale: mockLocale,
      slots: { inject, register },
      uiWorkspace: { openSession: vi.fn() },
    };

    const cleanup = plugin.apply(ctx);

    // Dictionaries registered for en, zh, and zh-CN
    expect(registerSpy).toHaveBeenCalledWith('peripheral', 'en', expect.any(Object));
    expect(registerSpy).toHaveBeenCalledWith('peripheral', 'zh', expect.any(Object));
    expect(registerSpy).toHaveBeenCalledWith('peripheral', 'zh-CN', expect.any(Object));

    // Initially Chinese
    const sidebarCall = register.mock.calls.find((call) => call[0]?.name === 'sidebar.panellist')?.[0];
    expect(sidebarCall?.label()).toBe('外设');

    // Switch to English
    activeLocale = 'en';
    expect(localeSubscriber).toBeTypeOf('function');
    localeSubscriber?.();

    // Dynamically reflects English translation
    expect(sidebarCall?.label()).toBe('Peripheral');

    if (typeof cleanup === 'function') cleanup();
  });

  it('renders upper slot list and lower NuPhy Air75 V3 keyboard visualization with slot mapping', () => {
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

    const renderedElements: Array<{ type: any; props: any; children: any[] }> = [];
    const mockReact = {
      createElement: vi.fn((type: any, props: any, ...children: any[]) => {
        const el = { type, props, children };
        renderedElements.push(el);
        return el;
      }),
      useState: vi.fn((init: any) => [init, () => {}]),
      useEffect: vi.fn(),
    };

    const plugin = mockModuleLoader.load.mock.calls[0][0].factory((name: string) =>
      name === 'react' ? mockReact : undefined
    );

    let panelComponent: (() => any) | null = null;
    const inject = vi.fn((_key: string, register: () => unknown) => {
      register();
      return () => {};
    });
    const register = vi.fn((meta: any, comp: any) => {
      if (meta.name === 'main' && meta.key === 'peripheral') {
        panelComponent = comp;
      }
      return () => {};
    });

    const openSessionSpy = vi.fn();
    const mockUiWorkspace = { openSession: openSessionSpy };
    const cleanup = plugin.apply({
      uiWorkspace: mockUiWorkspace,
      slots: { inject, register },
    });

    expect(panelComponent).not.toBeNull();

    // Populate snapshot with 2 active slots: Slot 1 is NEEDS_INPUT, Slot 2 is RUNNING
    capturedWs.onmessage({
      data: JSON.stringify({
        method: 'peripheral/snapshot',
        params: {
          focusedSlot: 1,
          slots: [
            {
              slotIndex: 1,
              sessionId: 'sess-approval-1',
              status: 'NEEDS_INPUT',
              activeTool: 'bash',
              question: { prompt: 'Allow bash command?' },
            },
            {
              slotIndex: 2,
              sessionId: 'sess-running-2',
              status: 'RUNNING',
              activeTool: 'read_file',
            },
          ],
        },
      }),
    });

    renderedElements.length = 0;
    panelComponent!();

    // 1. Check that NuPhy Air75 V3 HTML container #myKeyBoardBac is rendered
    const keyboardBac = renderedElements.find(
      (el) => el.type === 'div' && el.props && el.props.id === 'myKeyBoardBac'
    );
    expect(keyboardBac).toBeDefined();

    // 2. Check that frame image and roller are present
    const frameImg = renderedElements.find(
      (el) => el.type === 'img' && el.props && el.props.className === 'kb-frame'
    );
    expect(frameImg).toBeDefined();

    const rollerImg = renderedElements.find(
      (el) => el.type === 'img' && el.props && el.props.className === 'roller-img'
    );
    expect(rollerImg).toBeDefined();

    // 3. Check that .boxBacOut keycaps exist with wireframe structure
    const keyNodes = renderedElements.filter(
      (el) => el.type === 'div' && el.props && el.props.className === 'boxBacOut'
    );
    expect(keyNodes.length).toBe(83);

    // 4. Find key F2 (#key-KC_F2) and click it -> triggers switchFocus(2) and opens session
    const f2Node = keyNodes.find(
      (el) => el.props && (el.props.id === 'key-KC_F2' || el.props.key === 'key-KC_F2')
    );
    expect(f2Node).toBeDefined();
    f2Node?.props?.onClick();

    expect(openSessionSpy).toHaveBeenCalledWith('sess-running-2');
    const f2Sent = JSON.parse(capturedWs.send.mock.calls.at(-1)[0]);
    expect(f2Sent.method).toBe('peripheral/switchFocus');
    expect(f2Sent.params.slotIndex).toBe(2);

    // 5. In Slot 1 (NEEDS_INPUT), check that clicking virtual Enter key approves
    const enterNode = keyNodes.find(
      (el) => el.props && (el.props.id === 'key-KC_ENTER' || el.props.key === 'key-KC_ENTER')
    );
    expect(enterNode).toBeDefined();
    enterNode?.props?.onClick();

    const enterSent = JSON.parse(capturedWs.send.mock.calls.at(-1)[0]);
    expect(enterSent.method).toBe('peripheral/selectOption');
    expect(enterSent.params.action).toBe('ACCEPT');

    // 6. In Slot 1 (NEEDS_INPUT), check that clicking virtual Esc key rejects
    const escNode = keyNodes.find(
      (el) => el.props && (el.props.id === 'key-KC_ESC' || el.props.key === 'key-KC_ESC')
    );
    expect(escNode).toBeDefined();
    escNode?.props?.onClick();

    const escSent = JSON.parse(capturedWs.send.mock.calls.at(-1)[0]);
    expect(escSent.method).toBe('peripheral/selectOption');
    expect(escSent.params.action).toBe('REJECT');

    // 7. In Slot 1 (NEEDS_INPUT), check that clicking virtual 3 key allows always
    const key3Node = keyNodes.find(
      (el) => el.props && (el.props.id === 'key-KC_3' || el.props.key === 'key-KC_3')
    );
    expect(key3Node).toBeDefined();
    key3Node?.props?.onClick();

    const key3Sent = JSON.parse(capturedWs.send.mock.calls.at(-1)[0]);
    expect(key3Sent.method).toBe('peripheral/selectOption');
    expect(key3Sent.params.action).toBe('ALWAYS_ALLOW');

    // 8. Verify hover handlers on F-key nodes
    const f1Node = keyNodes.find(
      (el) => el.props && (el.props.id === 'key-KC_F1' || el.props.key === 'key-KC_F1')
    );
    expect(f1Node).toBeDefined();
    expect(typeof f1Node?.props?.onMouseEnter).toBe('function');
    expect(typeof f1Node?.props?.onMouseLeave).toBe('function');

    // 9. Verify exact wireframe sub-elements inside keycap
    const wireframeSubNodes = renderedElements.filter(
      (el) =>
        el.type === 'div' &&
        el.props &&
        (el.props.className === 'keyCapBg' ||
          el.props.className === 'wireframeBac' ||
          el.props.className === 'cap-left' ||
          el.props.className === 'cap-middle' ||
          el.props.className === 'cap-right' ||
          el.props.className === 'boxBac')
    );
    expect(wireframeSubNodes.length).toBeGreaterThan(0);

    if (typeof cleanup === 'function') cleanup();
  });
});
