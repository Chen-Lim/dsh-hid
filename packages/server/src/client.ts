/**
 * DeepSeek Harness Browser Companion Plugin
 *
 * Runs inside DeepSeek Harness Web UI / Electron renderer.
 * Bridges physical HID hardware focus switching to the DSH UI workspace,
 * allowing hardware keys (F1-F12) to switch active conversations in real-time.
 */

interface ModuleLoaderRegistration {
  id: string;
  factory: (require?: (name: string) => unknown) => {
    inject?: string[];
    apply: (ctx: any) => (() => void) | void;
  };
}

interface DshWindow extends Window {
  __ModuleLoader__?: {
    load(registration: ModuleLoaderRegistration): void;
  };
}

interface FocusChangedNotification {
  method?: string;
  params?: {
    focusedSlot?: number;
    sessionId?: string;
  };
}

const MODULE_ID = 'dsh-plugin-peripheral-server';
const WS_URL = 'ws://127.0.0.1:45678/peripheral/v1';

const win = typeof window !== 'undefined' ? (window as DshWindow) : undefined;

if (win?.__ModuleLoader__) {
  win.__ModuleLoader__.load({
    id: MODULE_ID,
    factory() {
      return {
        inject: ['uiWorkspace'],
        apply(ctx: any) {
          let ws: WebSocket | null = null;
          let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
          let disposed = false;
          let isHardwareNavigating = false;

          function connect() {
            if (disposed) return;
            try {
              ws = new WebSocket(WS_URL);

              ws.onopen = () => {
                // Connected to local peripheral server
              };

              ws.onmessage = (event: MessageEvent) => {
                try {
                  const data = JSON.parse(String(event.data)) as FocusChangedNotification;
                  if (data.method === 'peripheral/focusChanged' && data.params?.sessionId) {
                    const sid = data.params.sessionId;
                    isHardwareNavigating = true;
                    try {
                      if (ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function') {
                        ctx.uiWorkspace.openSession(sid);
                      }
                    } finally {
                      setTimeout(() => {
                        isHardwareNavigating = false;
                      }, 300);
                    }
                  }
                } catch (_) {}
              };

              ws.onclose = () => {
                ws = null;
                if (!disposed) {
                  reconnectTimer = setTimeout(connect, 1500);
                }
              };

              ws.onerror = () => {
                if (ws) ws.close();
              };
            } catch (_) {
              if (!disposed) {
                reconnectTimer = setTimeout(connect, 1500);
              }
            }
          }

          // Hook ctx.uiWorkspace.openSession to synchronize UI clicks with hardware
          if (ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function') {
            const originalOpenSession = ctx.uiWorkspace.openSession.bind(ctx.uiWorkspace);
            ctx.uiWorkspace.openSession = function (target: any) {
              const res = originalOpenSession(target);
              if (!isHardwareNavigating) {
                const sid =
                  typeof target === 'string'
                    ? target
                    : target?.childSessionId ?? target?.parentSessionId ?? target?.sessionId;
                if (sid && ws && ws.readyState === WebSocket.OPEN) {
                  try {
                    ws.send(
                      JSON.stringify({
                        jsonrpc: '2.0',
                        id: Date.now(),
                        method: 'peripheral/sessionOpened',
                        params: { sessionId: sid },
                      })
                    );
                  } catch (_) {}
                }
              }
              return res;
            };
          }

          connect();

          return () => {
            disposed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (ws) {
              try {
                ws.close();
              } catch (_) {}
            }
          };
        },
      };
    },
  });
}

export {};
