/**
 * DeepSeek Harness Browser Companion Plugin
 *
 * Runs inside DeepSeek Harness Web UI / Electron renderer. It
 * - registers the resident sidebar entry (`sidebar.panellist`) and its panel (`main`),
 * - mirrors slot/focus state from the peripheral bridge,
 * - forwards hardware focus switches to the UI and UI navigation back to the bridge,
 * - provides interactive NuPhy Air75 V3 / 84-key mechanical keyboard physical state visualizer.
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

interface UiTransportState {
  transport: 'usb' | '2.4g' | 'bluetooth' | 'disconnected' | string;
  model?: string;
  vendorId?: number;
  productId?: number;
  capabilities?: {
    rgb: boolean;
    keys: boolean;
    ledBlink: boolean;
    wireless: boolean;
  };
}

interface UiState {
  connected: boolean;
  focusedSlot: number;
  slots: UiSlot[];
  lastError: string | null;
  transportState?: UiTransportState | null;
}

interface KeyboardKeyDef {
  id: string;
  label: string;
  left: number;
  top: number;
  w: number;
  h: number;
  slot?: number;
}

const MODULE_ID = 'dsh-plugin-peripheral-server';
const WS_URL = 'ws://127.0.0.1:45678/peripheral/v1?role=ui';
const TOTAL_SLOTS = 12;

const STATUS_COLOR: Record<string, string> = {
  INACTIVE: 'var(--dsw-alias-state-idle-primary, #64748b)',
  IDLE: 'var(--dsw-alias-state-idle-primary, #94a3b8)',
  RUNNING: 'var(--dsw-alias-brand-primary, #38bdf8)',
  NEEDS_INPUT: 'var(--dsw-alias-state-warn-primary, #f59e0b)',
  COMPLETED: 'var(--dsw-alias-state-success-primary, #10b981)',
  ERROR: 'var(--dsw-alias-state-error-primary, #ef4444)',
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
  'transport.usb': 'USB',
  'transport.2.4g': '2.4G Wireless',
  'transport.bluetooth': 'Bluetooth (Keys Only)',
  'transport.disconnected': 'No Hardware',
  bluetoothNotice:
    'Bluetooth mode active: per-key RGB is unavailable over Bluetooth. Physical shortcut keys (F1–F12 / Y / N / Enter / Esc) and audio alerts remain active. Connect via USB or 2.4G Dongle for full RGB.',
  keyboardTitle: 'NuPhy Air75 V3 Physical Keyboard Indicator',
  keyboardSubtitle:
    'F1–F12 map to 12 agent slots. Click keycaps to switch focus or trigger quick actions.',
  keyHint:
    'Press physical F1–F12 to switch slots; press Enter/Y to accept or Esc/N to reject when input is needed.',
  accept: 'Accept',
  reject: 'Reject',
  alwaysAllow: 'Always Allow',
  quickActions: 'Actions',
  activeSlot: 'Active Slot',
  noSession: 'No Session',
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
  'transport.usb': '有线 USB',
  'transport.2.4g': '2.4G 无线',
  'transport.bluetooth': '蓝牙模式 (仅按键)',
  'transport.disconnected': '未检测到硬件',
  bluetoothNotice:
    '当前处于蓝牙连接模式：蓝牙协议不支持单键 RGB 灯效，物理快捷键（F1–F12 / Y / N / Enter / Esc）与声音提示仍正常工作。插入 2.4G 接收器或 USB 线即可恢复完整灯效。',
  keyboardTitle: 'NuPhy Air75 V3 物理键盘实时指示',
  keyboardSubtitle:
    'F1–F12 对应 12 个智能体槽位，支持点击键帽切换焦点与快捷操作。',
  keyHint:
    '按物理键 F1–F12 切换槽位；等待输入时按 Enter/Y 同意，Esc/N 拒绝',
  accept: '同意',
  reject: '拒绝',
  alwaysAllow: '总是允许',
  quickActions: '操作',
  activeSlot: '当前槽位',
  noSession: '无会话',
};

/**
 * Calibrated 83-key NuPhy Air75 V3 physical layout geometry (959 × 384 px).
 * F1–F12 keys map directly to Agent Slot 1–12.
 */
const AIR75_KEYS: KeyboardKeyDef[] = [
  // Row 0: ESC, F1..F12, PRTSC, DEL
  { id: 'KC_ESC', label: 'ESC', left: 19.9, top: 22.1, w: 55.2, h: 55.2 },
  { id: 'KC_F1', label: 'F1', left: 77.3, top: 22.1, w: 55.2, h: 55.2, slot: 1 },
  { id: 'KC_F2', label: 'F2', left: 134.7, top: 22.1, w: 55.2, h: 55.2, slot: 2 },
  { id: 'KC_F3', label: 'F3', left: 192.1, top: 22.1, w: 55.2, h: 55.2, slot: 3 },
  { id: 'KC_F4', label: 'F4', left: 249.5, top: 22.1, w: 55.2, h: 55.2, slot: 4 },
  { id: 'KC_F5', label: 'F5', left: 306.9, top: 22.1, w: 55.2, h: 55.2, slot: 5 },
  { id: 'KC_F6', label: 'F6', left: 364.3, top: 22.1, w: 55.2, h: 55.2, slot: 6 },
  { id: 'KC_F7', label: 'F7', left: 421.7, top: 22.1, w: 55.2, h: 55.2, slot: 7 },
  { id: 'KC_F8', label: 'F8', left: 479.1, top: 22.1, w: 55.2, h: 55.2, slot: 8 },
  { id: 'KC_F9', label: 'F9', left: 536.5, top: 22.1, w: 55.2, h: 55.2, slot: 9 },
  { id: 'KC_F10', label: 'F10', left: 594.0, top: 22.1, w: 55.2, h: 55.2, slot: 10 },
  { id: 'KC_F11', label: 'F11', left: 651.4, top: 22.1, w: 55.2, h: 55.2, slot: 11 },
  { id: 'KC_F12', label: 'F12', left: 708.8, top: 22.1, w: 55.2, h: 55.2, slot: 12 },
  { id: 'KC_FN_WIN_AREA_SCREENSHOT', label: 'PRTSC', left: 766.2, top: 22.1, w: 55.2, h: 55.2 },
  { id: 'KC_INSERT', label: 'DEL', left: 823.6, top: 22.1, w: 55.2, h: 55.2 },

  // Row 1: ~, 1..0, -, =, BACKSPACE, PGUP
  { id: 'KC_GRAVE', label: '~', left: 19.9, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_1', label: '1', left: 77.3, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_2', label: '2', left: 134.7, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_3', label: '3', left: 192.1, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_4', label: '4', left: 249.5, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_5', label: '5', left: 306.9, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_6', label: '6', left: 364.3, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_7', label: '7', left: 421.7, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_8', label: '8', left: 479.1, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_9', label: '9', left: 536.5, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_0', label: '0', left: 594.0, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_MINUS', label: '-', left: 651.4, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_EQUAL', label: '=', left: 708.8, top: 79.5, w: 55.2, h: 55.2 },
  { id: 'KC_BACKSPACE', label: 'BACKSPACE', left: 766.2, top: 79.5, w: 113.7, h: 55.2 },
  { id: 'KC_PAGE_UP', label: 'PGUP', left: 882.1, top: 79.5, w: 55.2, h: 55.2 },

  // Row 2: TAB, Q..P, [, ], \, PGDN
  { id: 'KC_TAB', label: 'TAB', left: 19.9, top: 136.9, w: 83.9, h: 55.2 },
  { id: 'KC_Q', label: 'Q', left: 106.0, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_W', label: 'W', left: 163.4, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_E', label: 'E', left: 220.8, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_R', label: 'R', left: 278.2, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_T', label: 'T', left: 335.6, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_Y', label: 'Y', left: 393.0, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_U', label: 'U', left: 450.4, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_I', label: 'I', left: 507.8, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_O', label: 'O', left: 565.3, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_P', label: 'P', left: 622.7, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_LEFT_BRACKET', label: '[', left: 680.1, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_RIGHT_BRACKET', label: ']', left: 737.5, top: 136.9, w: 55.2, h: 55.2 },
  { id: 'KC_BACKSLASH', label: '\\', left: 794.9, top: 136.9, w: 85.0, h: 55.2 },
  { id: 'KC_PAGE_DOWN', label: 'PGDN', left: 882.1, top: 136.9, w: 55.2, h: 55.2 },

  // Row 3: CAPS, A..L, ;, ', ENTER, HOME
  { id: 'KC_CAPS_LOCK', label: 'CAPS', left: 19.9, top: 194.3, w: 98.8, h: 55.2 },
  { id: 'KC_A', label: 'A', left: 120.9, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_S', label: 'S', left: 178.3, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_D', label: 'D', left: 235.7, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_F', label: 'F', left: 293.1, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_G', label: 'G', left: 350.5, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_H', label: 'H', left: 407.9, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_J', label: 'J', left: 465.3, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_K', label: 'K', left: 522.7, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_L', label: 'L', left: 580.2, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_SEMICOLON', label: ';', left: 637.6, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_QUOTE', label: "'", left: 695.0, top: 194.3, w: 55.2, h: 55.2 },
  { id: 'KC_ENTER', label: 'ENTER', left: 752.4, top: 194.3, w: 128.1, h: 55.2 },
  { id: 'KC_HOME', label: 'HOME', left: 882.7, top: 194.3, w: 55.2, h: 55.2 },

  // Row 4: SHIFT, Z..M, ,, ., /, SHIFT, ↑, END
  { id: 'KC_LSFT', label: 'SHIFT', left: 19.9, top: 250.6, w: 125.9, h: 55.2 },
  { id: 'KC_Z', label: 'Z', left: 147.9, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_X', label: 'X', left: 205.3, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_C', label: 'C', left: 262.8, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_V', label: 'V', left: 320.2, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_B', label: 'B', left: 377.6, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_N', label: 'N', left: 435.0, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_M', label: 'M', left: 492.4, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_COMMA', label: ',', left: 549.8, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_DOT', label: '.', left: 607.2, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_SLASH', label: '/', left: 664.6, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_RSFT', label: 'SHIFT', left: 722.0, top: 250.6, w: 100.5, h: 55.2 },
  { id: 'KC_UP', label: '↑', left: 824.7, top: 250.6, w: 55.2, h: 55.2 },
  { id: 'KC_END', label: 'END', left: 882.1, top: 250.6, w: 55.2, h: 55.2 },

  // Row 5: CTRL, OPT, CMD, SPACE, CMD, FN, CTRL, ←, ↓, →
  { id: 'KC_LCTL', label: 'CTRL', left: 19.9, top: 308.0, w: 69.0, h: 55.2 },
  { id: 'KC_LGUI', label: 'OPT', left: 91.1, top: 308.0, w: 69.0, h: 55.2 },
  { id: 'KC_LALT', label: 'CMD', left: 162.3, top: 308.0, w: 69.0, h: 55.2 },
  { id: 'KC_SPACE', label: 'SPACE', left: 233.5, top: 308.0, w: 358.8, h: 55.2 },
  { id: 'KC_RALT', label: 'CMD', left: 594.5, top: 308.0, w: 55.2, h: 55.2 },
  { id: 'KC_FN1', label: 'FN', left: 651.9, top: 308.0, w: 55.2, h: 55.2 },
  { id: 'KC_RCTL', label: 'CTRL', left: 709.3, top: 308.0, w: 55.2, h: 55.2 },
  { id: 'KC_LEFT', label: '←', left: 766.7, top: 308.0, w: 55.2, h: 55.2 },
  { id: 'KC_DOWN', label: '↓', left: 824.1, top: 308.0, w: 55.2, h: 55.2 },
  { id: 'KC_RIGHT', label: '→', left: 881.5, top: 308.0, w: 55.2, h: 55.2 },
];

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
          emit,
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
        inject: ['slots', 'uiWorkspace', 'locale'],
        apply(ctx: any) {
          const store = createStore();
          const disposers: Array<() => void> = [];
          const lifecycle = { disposed: false, navigating: false };
          let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
          let ws: WebSocket | null = null;
          let t: (key: string) => string = (key) => {
            const isZh =
              typeof navigator !== 'undefined' &&
              navigator.language?.toLowerCase().startsWith('zh');
            const dict = isZh ? ZH_DICT : EN_DICT;
            return (
              (dict as Record<string, string>)[key] ??
              (EN_DICT as Record<string, string>)[key] ??
              key
            );
          };

          const locale = typeof ctx.get === 'function' ? ctx.get('locale') : ctx?.locale;
          if (locale && typeof locale.register === 'function') {
            try {
              disposers.push(locale.register('peripheral', 'en', EN_DICT));
              disposers.push(locale.register('peripheral', 'zh', ZH_DICT));
              disposers.push(locale.register('peripheral', 'zh-CN', ZH_DICT));
              if (typeof locale.bind === 'function') {
                t = locale.bind('peripheral');
              }
            } catch {
              // Locale registration is cosmetic; keep the fallbacks on failure.
            }

            // Sync with host locale switch in real time
            if (typeof locale.subscribe === 'function') {
              try {
                const unsubscribe = locale.subscribe(() => {
                  store.emit();
                });
                if (typeof unsubscribe === 'function') {
                  disposers.push(unsubscribe);
                }
              } catch {}
            }
          }

          if (typeof ctx.on === 'function') {
            try {
              const unlisten = ctx.on('locale/change', () => {
                store.emit();
              });
              if (typeof unlisten === 'function') {
                disposers.push(unlisten);
              }
            } catch {}
          }

          function navigateToSession(sessionId: string | undefined): void {
            if (!sessionId) return;
            lifecycle.navigating = true;
            try {
              const uiWorkspace =
                typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : ctx?.uiWorkspace;
              uiWorkspace?.openSession?.(sessionId);
            } catch {
              // ignore
            } finally {
              setTimeout(() => {
                lifecycle.navigating = false;
              }, 300);
            }
          }

          function sendSwitchFocus(targetSlot: number): void {
            const snapshot = store.get();
            const slot = snapshot.slots.find((s) => s.slotIndex === targetSlot);
            if (slot?.sessionId) {
              navigateToSession(slot.sessionId);
            }
            store.patch({ focusedSlot: targetSlot });
            if (ws && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: Date.now(),
                    method: 'peripheral/switchFocus',
                    params: { slotIndex: targetSlot },
                  })
                );
              } catch {
                // ignore
              }
            }
          }

          function sendSelectOption(
            targetSlot: number,
            optionIndex: number,
            action: string
          ): void {
            if (ws && ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(
                  JSON.stringify({
                    jsonrpc: '2.0',
                    id: Date.now(),
                    method: 'peripheral/selectOption',
                    params: { slotIndex: targetSlot, optionIndex, action },
                  })
                );
              } catch {
                // ignore
              }
            }
          }

          function playApprovalChime(): void {
            try {
              const AudioCtx =
                (win as any)?.AudioContext || (win as any)?.webkitAudioContext;
              if (typeof AudioCtx !== 'function') return;
              const audioCtx = new AudioCtx();
              const now = audioCtx.currentTime ?? 0;
              const osc = audioCtx.createOscillator();
              const gain = audioCtx.createGain();
              osc.type = 'sine';
              osc.frequency.setValueAtTime(660, now);
              osc.frequency.setValueAtTime(880, now + 0.08);
              gain.gain.setValueAtTime(0.08, now);
              gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
              osc.connect(gain);
              gain.connect(audioCtx.destination);
              osc.start(now);
              osc.stop(now + 0.22);
            } catch {
              // Audio is best-effort compensation when per-key RGB is unavailable in Bluetooth mode.
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
                  ...(params.transportState ? { transportState: params.transportState } : {}),
                });
                break;
              case 'peripheral/slotUpdated': {
                const slot = params && params.slot ? params.slot : params;
                const prev = store
                  .get()
                  .slots.find((item) => item.slotIndex === slot?.slotIndex);
                store.patchSlot(params);
                const transport = store.get().transportState;
                if (
                  slot?.status === 'NEEDS_INPUT' &&
                  prev?.status !== 'NEEDS_INPUT' &&
                  (transport?.transport === 'bluetooth' || transport?.capabilities?.rgb === false)
                ) {
                  playApprovalChime();
                }
                break;
              }
              case 'peripheral/focusChanged':
                store.patch({
                  focusedSlot:
                    typeof params.focusedSlot === 'number'
                      ? params.focusedSlot
                      : store.get().focusedSlot,
                });
                navigateToSession(params.sessionId);
                break;
              case 'peripheral/transportChanged':
                if (params && typeof params.transport === 'string') {
                  store.patch({ transportState: params });
                }
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
          const uiWorkspace =
            typeof ctx.get === 'function' ? ctx.get('uiWorkspace') : ctx?.uiWorkspace;
          if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
            const originalOpenSession = uiWorkspace.openSession.bind(uiWorkspace);
            uiWorkspace.openSession = function (target: any) {
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
              uiWorkspace.openSession = originalOpenSession;
            });
          }

          function handleKeyDown(event: KeyboardEvent): void {
            if (event.metaKey || event.ctrlKey || event.altKey) return;

            // 1. F1..F12 physical/virtual keys
            const fMatch = /^F([1-9]|1[0-2])$/.exec(event.key);
            if (fMatch) {
              const targetSlot = parseInt(fMatch[1], 10);
              event.preventDefault();
              event.stopPropagation();
              sendSwitchFocus(targetSlot);
              return;
            }

            // 2. Decision keys when active slot is in NEEDS_INPUT
            const targetEl = event.target as HTMLElement | null;
            const targetTagName = targetEl?.tagName?.toLowerCase();
            const isInputTarget =
              targetTagName === 'input' ||
              targetTagName === 'textarea' ||
              targetEl?.isContentEditable === true;

            const snapshot = store.get();
            const currentSlot = snapshot.slots.find(
              (s) => s.slotIndex === snapshot.focusedSlot
            );
            if (!isInputTarget && currentSlot?.status === 'NEEDS_INPUT') {
              if (
                event.key === 'Enter' ||
                event.key === 'y' ||
                event.key === 'Y' ||
                event.key === '1'
              ) {
                event.preventDefault();
                event.stopPropagation();
                sendSelectOption(snapshot.focusedSlot, 0, 'ACCEPT');
              } else if (
                event.key === 'Escape' ||
                event.key === 'n' ||
                event.key === 'N' ||
                event.key === '2'
              ) {
                event.preventDefault();
                event.stopPropagation();
                sendSelectOption(snapshot.focusedSlot, 1, 'REJECT');
              } else if (event.key === '3') {
                event.preventDefault();
                event.stopPropagation();
                sendSelectOption(snapshot.focusedSlot, 2, 'ALWAYS_ALLOW');
              }
            }
          }

          if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('keydown', handleKeyDown, true);
            disposers.push(() => {
              if (typeof window.removeEventListener === 'function') {
                window.removeEventListener('keydown', handleKeyDown, true);
              }
            });
          }

          function statusLabel(status: string): string {
            const key = `status.${status}`;
            const label = t(key);
            return label === key ? status : label;
          }

          function transportLabel(transport: string | undefined): string | null {
            if (!transport) return null;
            const key = `transport.${transport.toLowerCase()}`;
            const label = t(key);
            return label === key ? transport.toUpperCase() : label;
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

          /**
           * Render one slot row in the upper status table.
           */
          function renderSlotRow(
            slot: UiSlot,
            current: UiState,
            hoveredSlot: number | null,
            setHoveredSlot: (s: number | null) => void
          ) {
            const focused = slot.slotIndex === current.focusedSlot;
            const isHovered = slot.slotIndex === hoveredSlot;
            const interactive = true;
            const shortSession = slot.sessionId ? String(slot.sessionId).slice(0, 8) : '—';
            const isNeedsInput = slot.status === 'NEEDS_INPUT';

            return h(
              'div',
              {
                key: slot.slotIndex,
                role: 'button',
                tabIndex: 0,
                onMouseEnter: () => setHoveredSlot(slot.slotIndex),
                onMouseLeave: () => setHoveredSlot(null),
                onClick: () => sendSwitchFocus(slot.slotIndex),
                onKeyDown: (event: any) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    sendSwitchFocus(slot.slotIndex);
                  }
                },
                style: {
                  display: 'grid',
                  gridTemplateColumns: '52px 140px 130px 1fr 160px',
                  alignItems: 'center',
                  gap: '12px',
                  padding: '9px 14px',
                  borderTop: slot.slotIndex === 1 ? 'none' : '1px solid var(--dsw-alias-border-l1)',
                  borderLeft: focused
                    ? '3px solid var(--dsw-alias-brand-primary, #38bdf8)'
                    : '3px solid transparent',
                  background: focused
                    ? 'var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.07))'
                    : isHovered
                    ? 'rgba(255, 255, 255, 0.03)'
                    : 'transparent',
                  cursor: interactive ? 'pointer' : 'default',
                  transition: 'background 0.15s ease, border-left 0.15s ease',
                },
              },
              // 1. Slot F-Key badge
              h(
                'span',
                {
                  style: {
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '38px',
                    height: '24px',
                    borderRadius: '5px',
                    border: focused
                      ? '1px solid var(--dsw-alias-brand-primary, #38bdf8)'
                      : '1px solid var(--dsw-alias-border-l1)',
                    background: focused
                      ? 'rgba(56, 189, 248, 0.15)'
                      : 'var(--dsw-alias-bg-layer-1, rgba(0, 0, 0, 0.2))',
                    fontSize: '12px',
                    fontWeight: 700,
                    color: focused
                      ? 'var(--dsw-alias-brand-primary, #38bdf8)'
                      : 'var(--dsw-alias-label-primary)',
                  },
                },
                `F${slot.slotIndex}`
              ),
              // 2. Session ID
              h(
                'span',
                {
                  style: {
                    fontFamily:
                      'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
                    fontSize: '12px',
                    color: slot.sessionId
                      ? 'var(--dsw-alias-label-primary)'
                      : 'var(--dsw-alias-label-secondary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  },
                },
                shortSession
              ),
              // 3. Status indicator
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
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: STATUS_COLOR[slot.status] ?? STATUS_COLOR.INACTIVE,
                    boxShadow:
                      slot.status === 'RUNNING' || slot.status === 'NEEDS_INPUT'
                        ? `0 0 6px ${STATUS_COLOR[slot.status]}`
                        : 'none',
                  },
                }),
                statusLabel(slot.status)
              ),
              // 4. Tool / Question Prompt
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
                slot.question?.prompt || slot.activeTool || ''
              ),
              // 5. Quick Actions column
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    gap: '6px',
                    alignItems: 'center',
                    justifyContent: 'flex-start',
                  },
                },
                isNeedsInput
                  ? [
                      h(
                        'button',
                        {
                          key: 'btn-accept',
                          type: 'button',
                          onClick: (e: any) => {
                            e.stopPropagation();
                            sendSelectOption(slot.slotIndex, 0, 'ACCEPT');
                          },
                          style: {
                            padding: '3px 8px',
                            borderRadius: '4px',
                            border: '1px solid var(--dsw-alias-state-success-primary, #10b981)',
                            background: 'rgba(16, 185, 129, 0.15)',
                            color: 'var(--dsw-alias-state-success-primary, #10b981)',
                            fontSize: '11px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          },
                        },
                        `✓ ${t('accept')} (Y)`
                      ),
                      h(
                        'button',
                        {
                          key: 'btn-reject',
                          type: 'button',
                          onClick: (e: any) => {
                            e.stopPropagation();
                            sendSelectOption(slot.slotIndex, 1, 'REJECT');
                          },
                          style: {
                            padding: '3px 8px',
                            borderRadius: '4px',
                            border: '1px solid var(--dsw-alias-state-error-primary, #ef4444)',
                            background: 'rgba(239, 68, 68, 0.15)',
                            color: 'var(--dsw-alias-state-error-primary, #ef4444)',
                            fontSize: '11px',
                            fontWeight: 600,
                            cursor: 'pointer',
                          },
                        },
                        `✕ ${t('reject')} (N)`
                      ),
                    ]
                  : slot.sessionId
                  ? h(
                      'span',
                      {
                        style: {
                          fontSize: '11px',
                          color: focused
                            ? 'var(--dsw-alias-brand-primary, #38bdf8)'
                            : 'var(--dsw-alias-label-secondary)',
                        },
                      },
                      focused ? `● ${t('activeSlot')}` : '↵'
                    )
                  : null
              )
            );
          }

          /**
           * Render the lower-half interactive NuPhy Air75 V3 physical keyboard visualizer.
           */
          function renderKeyboardVisualization(
            current: UiState,
            hoveredSlot: number | null,
            setHoveredSlot: (s: number | null) => void
          ) {
            const currentFocusedSlot = current.focusedSlot;
            const focusedSlotData = current.slots.find(
              (s) => s.slotIndex === currentFocusedSlot
            );
            const isFocusedSlotNeedsInput = focusedSlotData?.status === 'NEEDS_INPUT';

            const activeInspectSlot = hoveredSlot ?? currentFocusedSlot;
            const inspectSlotData = current.slots.find(
              (s) => s.slotIndex === activeInspectSlot
            );

            return h(
              'div',
              {
                style: {
                  marginTop: '22px',
                  padding: '20px',
                  borderRadius: '12px',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-1, #13161c)',
                  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.15)',
                },
              },
              // 1. Visualizer Header & Status Legend
              h(
                'div',
                {
                  style: {
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    marginBottom: '14px',
                  },
                },
                h(
                  'div',
                  null,
                  h(
                    'h2',
                    {
                      style: {
                        margin: '0 0 4px',
                        fontSize: '14px',
                        fontWeight: 600,
                        color: 'var(--dsw-alias-label-primary)',
                      },
                    },
                    t('keyboardTitle')
                  ),
                  h(
                    'p',
                    {
                      style: {
                        margin: 0,
                        fontSize: '12px',
                        color: 'var(--dsw-alias-label-secondary)',
                      },
                    },
                    t('keyboardSubtitle')
                  )
                ),
                // Legend pills
                h(
                  'div',
                  {
                    style: {
                      display: 'flex',
                      flexWrap: 'wrap',
                      gap: '8px',
                      alignItems: 'center',
                      fontSize: '11px',
                      color: 'var(--dsw-alias-label-secondary)',
                    },
                  },
                  ['IDLE', 'RUNNING', 'NEEDS_INPUT', 'COMPLETED', 'ERROR'].map((st) =>
                    h(
                      'span',
                      {
                        key: st,
                        style: {
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                          padding: '2px 7px',
                          borderRadius: '4px',
                          background: 'rgba(255, 255, 255, 0.04)',
                          border: '1px solid var(--dsw-alias-border-l1)',
                        },
                      },
                      h('span', {
                        style: {
                          width: '7px',
                          height: '7px',
                          borderRadius: '50%',
                          background: STATUS_COLOR[st],
                        },
                      }),
                      t(`status.${st}`)
                    )
                  )
                )
              ),
              // 2. SVG Keyboard Canvas (NuPhy Air75 V3 84-Key calibrated drawing)
              h(
                'div',
                {
                  style: {
                    width: '100%',
                    maxWidth: '960px',
                    margin: '0 auto',
                    position: 'relative',
                  },
                },
                h(
                  'svg',
                  {
                    viewBox: '0 0 959 384',
                    style: {
                      width: '100%',
                      height: 'auto',
                      display: 'block',
                      filter: 'drop-shadow(0 10px 20px rgba(0,0,0,0.35))',
                    },
                  },
                  // Definitions
                  h(
                    'defs',
                    null,
                    h(
                      'linearGradient',
                      { id: 'air75-case', x1: '0%', y1: '0%', x2: '100%', y2: '100%' },
                      h('stop', { offset: '0%', stopColor: '#232834' }),
                      h('stop', { offset: '100%', stopColor: '#171a22' })
                    ),
                    h(
                      'linearGradient',
                      { id: 'air75-roller', x1: '0%', y1: '0%', x2: '0%', y2: '100%' },
                      h('stop', { offset: '0%', stopColor: '#8a93a5' }),
                      h('stop', { offset: '25%', stopColor: '#4f5666' }),
                      h('stop', { offset: '50%', stopColor: '#a6afc2' }),
                      h('stop', { offset: '75%', stopColor: '#4f5666' }),
                      h('stop', { offset: '100%', stopColor: '#363c48' })
                    ),
                    h(
                      'filter',
                      { id: 'led-glow', x: '-20%', y: '-20%', width: '140%', height: '140%' },
                      h('feGaussianBlur', { stdDeviation: '3', result: 'blur' }),
                      h('feComposite', { in: 'SourceGraphic', in2: 'blur', operator: 'over' })
                    )
                  ),
                  // Chassis Outer Frame
                  h('rect', {
                    x: 4,
                    y: 6,
                    width: 951,
                    height: 372,
                    rx: 14,
                    fill: 'url(#air75-case)',
                    stroke: 'rgba(255, 255, 255, 0.14)',
                    strokeWidth: 1.5,
                  }),
                  // Inner Plate Well
                  h('rect', {
                    x: 11,
                    y: 13,
                    width: 937,
                    height: 358,
                    rx: 10,
                    fill: '#101217',
                    stroke: 'rgba(0, 0, 0, 0.6)',
                    strokeWidth: 1,
                  }),
                  // NuPhy Air75 V3 Volume Roller (Top Right)
                  h('rect', {
                    x: 884,
                    y: 20,
                    width: 53,
                    height: 44,
                    rx: 6,
                    fill: '#181b22',
                    stroke: 'rgba(255, 255, 255, 0.1)',
                  }),
                  h('rect', {
                    x: 887,
                    y: 22,
                    width: 47,
                    height: 40,
                    rx: 4,
                    fill: 'url(#air75-roller)',
                  }),
                  [28, 34, 40, 46, 52].map((y) =>
                    h('line', {
                      key: `roller-line-${y}`,
                      x1: 888,
                      y1: y,
                      x2: 933,
                      y2: y,
                      stroke: 'rgba(0,0,0,0.4)',
                      strokeWidth: 1,
                    })
                  ),
                  // NuPhy Brand Logo / Protocol info text
                  h(
                    'text',
                    {
                      x: 24,
                      y: 365,
                      fill: 'rgba(255, 255, 255, 0.35)',
                      fontSize: '8.5',
                      fontWeight: 600,
                      letterSpacing: '0.08em',
                      fontFamily: 'sans-serif',
                    },
                    'NUPHY AIR75 V3 · DSH PHYSICAL PERIPHERAL BRIDGE · 84-KEY LOW PROFILE'
                  ),
                  // 83 Keys rendering
                  AIR75_KEYS.map((key) => {
                    const isFKey = typeof key.slot === 'number';
                    const slotIndex = key.slot ?? 0;
                    const slotData = isFKey
                      ? current.slots.find((s) => s.slotIndex === slotIndex)
                      : undefined;
                    const slotStatus = isFKey ? slotData?.status ?? 'INACTIVE' : 'INACTIVE';
                    const isFocused = isFKey && currentFocusedSlot === slotIndex;
                    const isHovered = isFKey && hoveredSlot === slotIndex;
                    const statusColor = STATUS_COLOR[slotStatus] ?? STATUS_COLOR.INACTIVE;

                    // Quick-Response Decision Keys highlighting during active NEEDS_INPUT
                    const isAcceptKey =
                      isFocusedSlotNeedsInput &&
                      (key.id === 'KC_ENTER' || key.id === 'KC_Y' || key.id === 'KC_1');
                    const isRejectKey =
                      isFocusedSlotNeedsInput &&
                      (key.id === 'KC_ESC' || key.id === 'KC_N' || key.id === 'KC_2');
                    const isAlwaysAllowKey =
                      isFocusedSlotNeedsInput && key.id === 'KC_3';

                    // Keycap Background Fill
                    let keyFill = '#1e222b';
                    let keyStroke = 'rgba(255, 255, 255, 0.08)';
                    let textColor = 'rgba(255, 255, 255, 0.75)';
                    let cursor = 'default';

                    if (isFKey) {
                      cursor = 'pointer';
                      if (isFocused) {
                        keyFill = '#2d3546';
                        keyStroke = 'var(--dsw-alias-brand-primary, #38bdf8)';
                        textColor = '#ffffff';
                      } else if (isHovered) {
                        keyFill = '#262d3b';
                        keyStroke = 'rgba(255, 255, 255, 0.4)';
                        textColor = '#ffffff';
                      } else if (slotStatus === 'RUNNING') {
                        keyFill = 'rgba(56, 189, 248, 0.12)';
                        keyStroke = 'rgba(56, 189, 248, 0.4)';
                      } else if (slotStatus === 'NEEDS_INPUT') {
                        keyFill = 'rgba(245, 158, 11, 0.15)';
                        keyStroke = 'rgba(245, 158, 11, 0.5)';
                      }
                    } else if (isAcceptKey) {
                      cursor = 'pointer';
                      keyFill = 'rgba(16, 185, 129, 0.25)';
                      keyStroke = 'var(--dsw-alias-state-success-primary, #10b981)';
                      textColor = '#a7f3d0';
                    } else if (isRejectKey) {
                      cursor = 'pointer';
                      keyFill = 'rgba(239, 68, 68, 0.25)';
                      keyStroke = 'var(--dsw-alias-state-error-primary, #ef4444)';
                      textColor = '#fecaca';
                    } else if (isAlwaysAllowKey) {
                      cursor = 'pointer';
                      keyFill = 'rgba(245, 158, 11, 0.2)';
                      keyStroke = 'var(--dsw-alias-state-warn-primary, #f59e0b)';
                      textColor = '#fde68a';
                    } else if (key.id === 'KC_ESC') {
                      keyFill = '#282326';
                      keyStroke = 'rgba(239, 68, 68, 0.2)';
                    } else if (key.id === 'KC_ENTER') {
                      keyFill = '#212936';
                      keyStroke = 'rgba(56, 189, 248, 0.2)';
                    } else if (key.id === 'KC_SPACE') {
                      keyFill = '#212530';
                    }

                    return h(
                      'g',
                      {
                        key: key.id,
                        style: { cursor },
                        onClick: () => {
                          if (isFKey) {
                            sendSwitchFocus(slotIndex);
                          } else if (isAcceptKey) {
                            sendSelectOption(currentFocusedSlot, 0, 'ACCEPT');
                          } else if (isRejectKey) {
                            sendSelectOption(currentFocusedSlot, 1, 'REJECT');
                          } else if (isAlwaysAllowKey) {
                            sendSelectOption(currentFocusedSlot, 2, 'ALWAYS_ALLOW');
                          }
                        },
                        onMouseEnter: isFKey ? () => setHoveredSlot(slotIndex) : undefined,
                        onMouseLeave: isFKey ? () => setHoveredSlot(null) : undefined,
                      },
                      // Keycap Base Body
                      h('rect', {
                        x: key.left,
                        y: key.top,
                        width: key.w,
                        height: key.h,
                        rx: 5.5,
                        fill: keyFill,
                        stroke: keyStroke,
                        strokeWidth: isFocused ? 2 : isAcceptKey || isRejectKey ? 1.8 : 1,
                      }),
                      // F-Key Per-Key RGB LED Indicator Bar
                      isFKey
                        ? h('rect', {
                            x: key.left + 7,
                            y: key.top + 5,
                            width: key.w - 14,
                            height: 3,
                            rx: 1.5,
                            fill: statusColor,
                            opacity: slotStatus === 'INACTIVE' ? 0.25 : 1,
                            filter:
                              slotStatus === 'RUNNING' || slotStatus === 'NEEDS_INPUT'
                                ? 'url(#led-glow)'
                                : undefined,
                          })
                        : null,
                      // Key Legend Text
                      h(
                        'text',
                        {
                          x: key.left + key.w / 2,
                          y: isFKey ? key.top + 33 : key.top + key.h / 2 + 4,
                          textAnchor: 'middle',
                          fill: textColor,
                          fontSize: isFKey ? 11.5 : key.label.length > 3 ? 9 : 11,
                          fontWeight: 700,
                          fontFamily:
                            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
                        },
                        isAcceptKey && key.id === 'KC_ENTER'
                          ? 'ENTER ✓'
                          : isRejectKey && key.id === 'KC_ESC'
                          ? 'ESC ✕'
                          : key.label
                      ),
                      // F-Key Focused Dot
                      isFocused
                        ? h('circle', {
                            cx: key.left + key.w / 2,
                            cy: key.top + 45,
                            r: 2,
                            fill: 'var(--dsw-alias-brand-primary, #38bdf8)',
                          })
                        : null
                    );
                  })
                )
              ),
              // 3. Interactive Information Strip below the keyboard
              h(
                'div',
                {
                  style: {
                    marginTop: '14px',
                    padding: '10px 14px',
                    borderRadius: '8px',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-layer-2, rgba(255, 255, 255, 0.05))',
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: '12px',
                    fontSize: '12px',
                  },
                },
                h(
                  'div',
                  {
                    style: {
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: '8px',
                    },
                  },
                  h(
                    'span',
                    {
                      style: {
                        fontWeight: 700,
                        color: 'var(--dsw-alias-brand-primary, #38bdf8)',
                      },
                    },
                    `F${activeInspectSlot}`
                  ),
                  h(
                    'span',
                    {
                      style: {
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '5px',
                        padding: '1px 7px',
                        borderRadius: '4px',
                        background: 'rgba(255, 255, 255, 0.06)',
                      },
                    },
                    h('span', {
                      style: {
                        width: '7px',
                        height: '7px',
                        borderRadius: '50%',
                        background:
                          STATUS_COLOR[inspectSlotData?.status ?? 'INACTIVE'] ??
                          STATUS_COLOR.INACTIVE,
                      },
                    }),
                    statusLabel(inspectSlotData?.status ?? 'INACTIVE')
                  ),
                  inspectSlotData?.sessionId
                    ? h(
                        'span',
                        {
                          style: {
                            fontFamily:
                              'var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace)',
                            color: 'var(--dsw-alias-label-secondary)',
                          },
                        },
                        `${t('session')}: ${inspectSlotData.sessionId.slice(0, 8)}…`
                      )
                    : h(
                        'span',
                        { style: { color: 'var(--dsw-alias-label-secondary)' } },
                        t('noSession')
                      ),
                  inspectSlotData?.activeTool
                    ? h(
                        'span',
                        { style: { color: 'var(--dsw-alias-label-secondary)' } },
                        `· ${t('tool')}: ${inspectSlotData.activeTool}`
                      )
                    : null
                ),
                h(
                  'div',
                  {
                    style: {
                      color: 'var(--dsw-alias-label-secondary)',
                      fontSize: '11px',
                    },
                  },
                  `💡 ${t('keyHint')}`
                )
              )
            );
          }

          function PeripheralPanel() {
            const current = useStore(store);
            const [hoveredSlot, setHoveredSlot] = React.useState(null as number | null);

            const rows: UiSlot[] = current.slots.length
              ? current.slots
              : Array.from({ length: TOTAL_SLOTS }, (_, index) => ({
                  slotIndex: index + 1,
                  status: 'INACTIVE',
                }));

            const transportMode = current.transportState?.transport?.toLowerCase();
            const badgeText =
              current.connected && transportMode ? transportLabel(transportMode) : null;
            const isBluetoothFallback =
              current.connected && transportMode === 'bluetooth';

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
              // Top Header
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
                ),
                badgeText
                  ? h(
                      'span',
                      {
                        'data-testid': 'peripheral-transport-badge',
                        style: {
                          fontSize: '11px',
                          padding: '2px 8px',
                          borderRadius: '999px',
                          border: '1px solid var(--dsw-alias-border-l1)',
                          background: 'var(--dsw-alias-bg-layer-1)',
                          color: isBluetoothFallback
                            ? 'var(--dsw-alias-state-warn-primary)'
                            : 'var(--dsw-alias-label-secondary)',
                        },
                      },
                      current.transportState?.model
                        ? `${current.transportState.model} · ${badgeText}`
                        : badgeText
                    )
                  : null
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
              isBluetoothFallback
                ? h(
                    'div',
                    {
                      role: 'status',
                      'data-testid': 'peripheral-bluetooth-notice',
                      style: {
                        margin: '0 0 14px',
                        padding: '10px 12px',
                        borderRadius: '6px',
                        border: '1px solid var(--dsw-alias-state-warn-primary)',
                        background: 'var(--dsw-alias-bg-layer-1)',
                        fontSize: '12px',
                        lineHeight: 1.5,
                        color: 'var(--dsw-alias-label-primary)',
                      },
                    },
                    t('bluetoothNotice')
                  )
                : null,
              // Upper Half: Slot Status Table
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
                      gridTemplateColumns: '52px 140px 130px 1fr 160px',
                      gap: '12px',
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
                  h('span', null, t('tool')),
                  h('span', null, t('quickActions'))
                ),
                rows.map((row) =>
                  renderSlotRow(row, current, hoveredSlot, setHoveredSlot)
                )
              ),
              // Lower Half: Interactive NuPhy Air75 V3 Physical Keyboard Visualizer
              renderKeyboardVisualization(current, hoveredSlot, setHoveredSlot),
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

          const slots = typeof ctx.get === 'function' ? ctx.get('slots') : ctx?.slots;
          if (React && slots && typeof slots.inject === 'function') {
            try {
              disposers.push(
                slots.inject('sidebar.panellist', () =>
                  slots.register(
                    {
                      name: 'sidebar.panellist',
                      id: 'peripheral',
                      order: 20,
                      locale: 'peripheral',
                      label: () => t('title'),
                    },
                    PeripheralIcon
                  )
                )
              );
              disposers.push(
                slots.inject('main', () =>
                  slots.register(
                    {
                      name: 'main',
                      key: 'peripheral',
                      locale: 'peripheral',
                    },
                    PeripheralPanel
                  )
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
