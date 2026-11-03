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
};

export const ZH_CN_MESSAGES: MessageCatalog = {
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
};

export const PERIPHERAL_CATALOGS: CatalogSet = {
  en: EN_MESSAGES,
  'zh-CN': ZH_CN_MESSAGES,
};
