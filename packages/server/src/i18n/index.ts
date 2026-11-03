/**
 * i18n scaffold for the peripheral bridge UI.
 *
 * Current state: framework + catalogs + host registration adapter. The client
 * bundle still carries its inline dictionaries because `client.js` must remain
 * a single dependency-free browser module; wiring it here is tracked separately
 * (see `docs/spec/i18n.md`).
 */

export type {
  CatalogSet,
  I18n,
  I18nOptions,
  LocaleId,
  LocaleInput,
  LocaleServiceHost,
  LocaleServiceLike,
  MessageCatalog,
  MessageParams,
  Translate,
} from './types.js';

export {
  DEFAULT_FALLBACK_LOCALE,
  createI18n,
  formatMessage,
  normalizeLocale,
} from './core.js';

export type { CordisLocaleBinding } from './cordis.js';
export { bindCordisLocale, getLocaleService } from './cordis.js';

export {
  EN_MESSAGES,
  PERIPHERAL_CATALOGS,
  PERIPHERAL_NAMESPACE,
  ZH_CN_MESSAGES,
} from './catalog.js';
