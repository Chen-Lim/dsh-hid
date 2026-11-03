/**
 * DeepSeek Harness Browser Companion Plugin
 *
 * Runs inside DeepSeek Harness Web UI / Electron renderer. It
 * - registers the resident sidebar entry (`sidebar.panellist`) and its panel (`main`),
 * - mirrors slot/focus state from the peripheral bridge,
 * - forwards hardware focus switches to the UI and UI navigation back to the bridge.
 *
 * Loaded through `window.__ModuleLoader__`; the registration id must equal the package name.
 * Connects with `role=ui` so the bridge does not count this page as a hardware daemon.
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

interface UiSlot {
  slotIndex: number;
  sessionId?: string | null;
  status: string;
  brainpower?: string;
  activeTool?: string;
  question?: { prompt: string; options: string[] };
}

interface UiState {
  connected: boolean;
  focusedSlot: number;
  slots: UiSlot[];
  lastError: string | null;
}

const MODULE_ID = 'dsh-plugin-peripheral-server';
const WS_URL = 'ws://127.0.0.1:45678/peripheral/v1?role=ui';
const TOTAL_SLOTS = 12;

const STATUS_COLOR: Record<string, string> = {
  INACTIVE: 'var(--dsw-alias-state-idle-primary)',
  IDLE: 'var(--dsw-alias-state-idle-primary)',
  RUNNING: 'var(--dsw-alias-brand-primary)',
  NEEDS_INPUT: 'var(--dsw-alias-state-warn-primary)',
  COMPLETED: 'var(--dsw-alias-state-success-primary)',
  ERROR: 'var(--dsw-alias-state-error-primary)',
};

const EN_DICT = {
  title: 'Peripheral',
  subtitle: 'Physical slot status reported by the peripheral bridge.',
  connected: 'Bridge connected',
  disconnected: 'Bridge offline',
  slot: 'Slot',
  session: 'Session',
  status: 'Status',
  tool: 'Tool',
  error: 'Connection error. Retrying…',
  'status.INACTIVE': 'Inactive',
  'status.IDLE': 'Idle',
  'status.RUNNING': 'Running',
  'status.NEEDS_INPUT': 'Needs input',
  'status.COMPLETED': 'Completed',
  'status.ERROR': 'Error',
};

const ZH_DICT = {
  title: '外设',
  subtitle: '由外设桥接服务上报的物理槽位状态。',
  connected: '桥接已连接',
  disconnected: '桥接未连接',
  slot: '槽位',
  session: '会话',
  status: '状态',
  tool: '工具',
  error: '连接异常，正在重试…',
  'status.INACTIVE': '未使用',
  'status.IDLE': '空闲',
  'status.RUNNING': '运行中',
  'status.NEEDS_INPUT': '等待输入',
  'status.COMPLETED': '已完成',
  'status.ERROR': '异常',
};

const win = typeof window !== 'undefined' ? (window as DshWindow) : undefined;

if (win?.__ModuleLoader__) {
  win.__ModuleLoader__.load({
    id: MODULE_ID,
    factory(require) {
      const React: any = typeof require === 'function' ? require('react') : undefined;
      const h: any = React ? React.createElement : undefined;

      function createStore() {
        let state: UiState = { connected: false, focusedSlot: 1, slots: [], lastError: null };
        const listeners = new Set<() => void>();
        const emit = () => {
          for (const listener of listeners) {
            try {
              listener();
            } catch {
              // A broken subscriber must not break the state feed.
            }
          }
        };
        return {
          get: (): UiState => state,
          subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          patch(next: Partial<UiState>): void {
            state = { ...state, ...next };
            emit();
          },
          patchSlot(raw: any): void {
            const slot = raw && raw.slot ? raw.slot : raw;
            if (!slot || typeof slot.slotIndex !== 'number') return;
            const exists = state.slots.some((item) => item.slotIndex === slot.slotIndex);
            state = {
              ...state,
              slots: exists
                ? state.slots.map((item) =>
                    item.slotIndex === slot.slotIndex ? { ...item, ...slot } : item
                  )
                : [...state.slots, slot].sort((a, b) => a.slotIndex - b.slotIndex),
            };
            emit();
          },
        };
      }

      function useStore(store: ReturnType<typeof createStore>): UiState {
        const [, forceRender] = React.useState(0);
        React.useEffect(
          () =>
            store.subscribe(() => {
              forceRender((n: number) => n + 1);
            }),
          [store]
        );
        return store.get();
      }

      function summarize(current: UiState): string {
        if (!current.connected) return 'INACTIVE';
        if (current.slots.some((slot) => slot.status === 'NEEDS_INPUT')) return 'NEEDS_INPUT';
        if (current.slots.some((slot) => slot.status === 'ERROR')) return 'ERROR';
        if (current.slots.some((slot) => slot.status === 'RUNNING')) return 'RUNNING';
        if (current.slots.some((slot) => slot.status === 'COMPLETED')) return 'COMPLETED';
        return 'IDLE';
      }

      return {
        inject: ['uiWorkspace'],
        apply(ctx: any) {
          const store = createStore();
          const disposers: Array<() => void> = [];
          const lifecycle = { disposed: false, navigating: false };
          let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
          let ws: WebSocket | null = null;
          let t: (key: string) => string = (key) =>
            (EN_DICT as Record<string, string>)[key] ?? key;

          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx.locale;
          if (locale && typeof locale.register === 'function') {
            try {
              disposers.push(locale.register('peripheral', 'en', EN_DICT));
              disposers.push(locale.register('peripheral', 'zh-CN', ZH_DICT));
              disposers.push(locale.register('peripheral', 'zh', ZH_DICT));
              t = locale.bind('peripheral');
            } catch {
              // Locale registration is cosmetic; keep the English fallbacks on failure.
            }
          }

          function navigateToSession(sessionId: string | undefined): void {
            if (!sessionId) return;
            lifecycle.navigating = true;
            try {
              ctx.uiWorkspace?.openSession?.(sessionId);
            } finally {
              setTimeout(() => {
                lifecycle.navigating = false;
              }, 300);
            }
          }

          function handleMessage(raw: string): void {
            let data: any;
            try {
              data = JSON.parse(raw);
            } catch {
              return;
            }
            const params = data?.params ?? {};
            switch (data?.method) {
              case 'peripheral/snapshot':
                store.patch({
                  connected: true,
                  focusedSlot: typeof params.focusedSlot === 'number' ? params.focusedSlot : 1,
                  slots: Array.isArray(params.slots) ? params.slots : [],
                });
                break;
              case 'peripheral/slotUpdated':
                store.patchSlot(params);
                break;
              case 'peripheral/focusChanged':
                store.patch({
                  focusedSlot:
                    typeof params.focusedSlot === 'number'
                      ? params.focusedSlot
                      : store.get().focusedSlot,
                });
                navigateToSession(params.sessionId);
                break;
              default:
                break;
            }
          }

          function scheduleReconnect(): void {
            if (lifecycle.disposed || reconnectTimer) return;
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connect();
            }, 1500);
          }

          function connect(): void {
            if (lifecycle.disposed) return;
            try {
              ws = new WebSocket(WS_URL);
              ws.onopen = () => store.patch({ connected: true, lastError: null });
              ws.onmessage = (event: MessageEvent) => handleMessage(String(event.data));
              ws.onclose = () => {
                ws = null;
                store.patch({ connected: false });
                scheduleReconnect();
              };
              ws.onerror = () => {
                store.patch({ connected: false, lastError: 'socket' });
                if (ws) {
                  try {
                    ws.close();
                  } catch {
                    // ignore
                  }
                }
              };
            } catch {
              store.patch({ connected: false, lastError: 'socket' });
              scheduleReconnect();
            }
          }

          // Keep UI navigation and the bridge focus in sync for clicks inside the app.
          if (ctx.uiWorkspace && typeof ctx.uiWorkspace.openSession === 'function') {
            const originalOpenSession = ctx.uiWorkspace.openSession.bind(ctx.uiWorkspace);
            ctx.uiWorkspace.openSession = function (target: any) {
              const result = originalOpenSession(target);
              if (!lifecycle.navigating) {
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
                  } catch {
                    // The bridge is best-effort from the UI side.
                  }
                }
              }
              return result;
            };
            disposers.push(() => {
              ctx.uiWorkspace.openSession = originalOpenSession;
            });
          }

          function statusLabel(status: string): string {
            const key = `status.${status}`;
            const label = t(key);
            return label === key ? status : label;
          }

          function PeripheralIcon(props: { size?: number; active?: boolean }) {
            const current = useStore(store);
            const size = props?.size || 16;
            const status = summarize(current);
            const accent = props?.active
              ? 'var(--dsw-alias-label-primary)'
              : 'var(--dsw-alias-label-secondary)';
            return h(
              'svg',
              {
                width: size,
                height: size,
                viewBox: '0 0 24 24',
                fill: 'none',
                'aria-hidden': true,
                style: { display: 'block' },
              },
              h('rect', {
                x: 2.75,
                y: 6,
                width: 18.5,
                height: 12,
                rx: 2.6,
                stroke: accent,
                strokeWidth: 1.5,
              }),
              h('path', {
                d: 'M6.25 10.25h3.2M6.25 13.75h5.2',
                stroke: accent,
                strokeWidth: 1.3,
                strokeLinecap: 'round',
              }),
              h('circle', {
                cx: 18,
                cy: 10.5,
                r: 2.2,
                fill: STATUS_COLOR[status] ?? STATUS_COLOR.INACTIVE,
              })
            );
          }

          function renderRow(slot: UiSlot) {
            const focused = slot.slotIndex === store.get().focusedSlot;
            const interactive = Boolean(slot.sessionId);
            const shortSession = slot.sessionId ? String(slot.sessionId).slice(0, 8) : '—';
            return h(
              'div',
              {
                key: slot.slotIndex,
                role: interactive ? 'button' : undefined,
                tabIndex: interactive ? 0 : undefined,
                onClick: interactive
                  ? () => navigateToSession(slot.sessionId ?? undefined)
                  : undefined,
                onKeyDown: interactive
                  ? (event: any) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        navigateToSession(slot.sessionId ?? undefined);
                      }
                    }
                  : undefined,
                style: {
                  display: 'grid',
                  gridTemplateColumns: '44px 1fr 120px 1fr',
                  alignItems: 'center',
                  gap: '10px',
                  padding: '10px 14px',
                  borderTop: slot.slotIndex === 1 ? 'none' : '1px solid var(--dsw-alias-border-l1)',
                  background: focused ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  cursor: interactive ? 'pointer' : 'default',
                },
              },
              h(
                'span',
                {
                  style: {
                    fontSize: '12px',
                    fontWeight: 600,
                    color: focused
                      ? 'var(--dsw-alias-label-primary)'
                      : 'var(--dsw-alias-label-secondary)',
                  },
                },
                `F${slot.slotIndex}`
              ),
              h(
                'span',
                {
                  style: {
                    fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                shortSession
              ),
              h(
                'span',
                {
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                h('span', {
                  style: {
                    width: '7px',
                    height: '7px',
                    borderRadius: '50%',
                    background: STATUS_COLOR[slot.status] ?? STATUS_COLOR.INACTIVE,
                  },
                }),
                statusLabel(slot.status)
              ),
              h(
                'span',
                {
                  style: {
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                slot.activeTool ?? ''
              )
            );
          }

          function PeripheralPanel() {
            const current = useStore(store);
            const rows: UiSlot[] = current.slots.length
              ? current.slots
              : Array.from({ length: TOTAL_SLOTS }, (_, index) => ({
                  slotIndex: index + 1,
                  status: 'INACTIVE',
                }));
            return h(
              'div',
              {
                style: {
                  height: '100%',
                  overflow: 'auto',
                  padding: '24px 28px',
                  color: 'var(--dsw-alias-label-primary)',
                  background: 'var(--dsw-alias-bg-base)',
                  boxSizing: 'border-box',
                },
              },
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    alignItems: 'baseline',
                    gap: '10px',
                    marginBottom: '6px',
                  },
                },
                h('h1', { style: { margin: 0, fontSize: '16px', fontWeight: 600 } }, t('title')),
                h(
                  'span',
                  {
                    style: {
                      fontSize: '12px',
                      color: current.connected
                        ? 'var(--dsw-alias-state-success-primary)'
                        : 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  current.connected ? t('connected') : t('disconnected')
                )
              ),
              h(
                'p',
                {
                  style: {
                    margin: '0 0 16px',
                    fontSize: '12px',
                    color: 'var(--dsw-alias-label-secondary)',
                  },
                },
                t('subtitle')
              ),
              h(
                'div',
                {
                  style: {
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: '8px',
                    overflow: 'hidden',
                  },
                },
                h(
                  'div',
                  {
                    style: {
                      display: 'grid',
                      gridTemplateColumns: '44px 1fr 120px 1fr',
                      gap: '10px',
                      padding: '8px 14px',
                      fontSize: '11px',
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: 'var(--dsw-alias-label-secondary)',
                      background: 'var(--dsw-alias-bg-layer-1)',
                      borderBottom: '1px solid var(--dsw-alias-border-l1)',
                    },
                  },
                  h('span', null, t('slot')),
                  h('span', null, t('session')),
                  h('span', null, t('status')),
                  h('span', null, t('tool'))
                ),
                rows.map(renderRow)
              ),
              current.lastError
                ? h(
                    'p',
                    {
                      style: {
                        margin: '12px 0 0',
                        fontSize: '12px',
                        color: 'var(--dsw-alias-state-error-primary)',
                      },
                    },
                    t('error')
                  )
                : null
            );
          }

          const slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx.slots;
          if (React && slots && typeof slots.inject === 'function') {
            try {
              disposers.push(
                slots.inject('sidebar.panellist', () =>
                  slots.register(
                    {
                      name: 'sidebar.panellist',
                      id: 'peripheral',
                      order: 20,
                      label: () => t('title'),
                    },
                    PeripheralIcon
                  )
                )
              );
              disposers.push(
                slots.inject('main', () =>
                  slots.register({ name: 'main', key: 'peripheral' }, PeripheralPanel)
                )
              );
            } catch (err) {
              console.error('[dsh-plugin-peripheral-server] slot registration failed:', err);
            }
          }

          connect();

          return () => {
            lifecycle.disposed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            if (ws) {
              try {
                ws.close();
              } catch {
                // ignore
              }
            }
            for (const dispose of disposers) {
              try {
                dispose();
              } catch {
                // ignore
              }
            }
          };
        },
      };
    },
  });
}

export {};
