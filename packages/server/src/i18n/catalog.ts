/**
 * Peripheral UI catalog — the single source of truth for user-visible strings.
 *
 * `packages/server/locale/*.json` mirrors this file for packaging / Plugin
 * Manager metadata; `test/i18n.test.ts` fails if the two drift apart.
 *
 * Key namespace: `meta.*` is consumed by the Plugin Manager card, everything
 * else is namespaced at registration time (`peripheral`).
 */

import type { CatalogSet, MessageCatalog } from './types.js';

/** Locale service namespace used for this plugin. */
export const PERIPHERAL_NAMESPACE = 'peripheral';

export const EN_MESSAGES: MessageCatalog = {
  meta: {
    title: 'Peripheral',
    description: 'Physical slot status reported by the peripheral bridge.',
  },
  'meta.title': 'Peripheral',
  'meta.description': 'Physical slot status reported by the peripheral bridge.',

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
  hotStart: 'Hot Start',
  stopService: 'Stop Service',
  restartService: 'Restart Service',
  dormantNotice:
    'Peripheral bridge service is stopped. You can click \'Hot Start\' at any time to resume hardware sync without restarting DeepSeek Harness.',
  serviceRunning: 'Service Running',
  serviceStopped: 'Service Stopped',
};

export const ZH_MESSAGES: MessageCatalog = {
  meta: {
    title: '外设',
    description: '由外设桥接服务上报的物理槽位状态。',
  },
  'meta.title': '外设',
  'meta.description': '由外设桥接服务上报的物理槽位状态。',

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
  hotStart: '热启动服务',
  stopService: '关闭外设服务',
  restartService: '重启服务',
  dormantNotice:
    '外设桥接服务已关闭。无须重启 DeepSeek Harness，点击“热启动服务”即可随时恢复外设硬件指示与按键交互。',
  serviceRunning: '服务运行中',
  serviceStopped: '服务已停止',
};

export const ZH_CN_MESSAGES: MessageCatalog = ZH_MESSAGES;

export const PERIPHERAL_CATALOGS: CatalogSet = {
  en: EN_MESSAGES,
  zh: ZH_MESSAGES,
  'zh-CN': ZH_CN_MESSAGES,
};
