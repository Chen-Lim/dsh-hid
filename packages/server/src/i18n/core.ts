/**
 * Framework-agnostic translation core: locale negotiation, interpolation and
 * fallback lookups. No Cordis / DOM dependencies, so it runs in the host, the
 * browser bundle and unit tests alike.
 */

import type {
  CatalogSet,
  I18n,
  I18nOptions,
  LocaleId,
  LocaleInput,
  MessageParams,
  Translate,
} from './types.js';

export const DEFAULT_FALLBACK_LOCALE: LocaleId = 'en';

/**
 * Resolve arbitrary locale input (`zh`, `zh-Hans-CN`, `en_US`, ...) against the
 * locales that actually have a catalog.
 *
 * Matching order: exact (case-insensitive) -> progressively shorter subtags ->
 * base language.
 */
export function normalizeLocale(
  input: LocaleInput | null | undefined,
  locales: readonly LocaleId[]
): LocaleId | undefined {
  if (!input) return undefined;
  const value = String(input).trim().replace(/_/g, '-');
  if (!value) return undefined;

  const exact = locales.find((locale) => locale.toLowerCase() === value.toLowerCase());
  if (exact) return exact;

  const parts = value.toLowerCase().split('-');
  while (parts.length > 1) {
    parts.pop();
    const candidate = parts.join('-');
    const hit = locales.find((locale) => locale.toLowerCase() === candidate);
    if (hit) return hit;
  }

  const base = value.toLowerCase().split('-')[0];
  return locales.find((locale) => locale.toLowerCase().split('-')[0] === base);
}

/** Replace `{name}` placeholders; unknown placeholders are left untouched. */
export function formatMessage(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

function lookup(
  catalogs: CatalogSet,
  locale: LocaleId,
  key: string
): string | undefined {
  const catalog = catalogs[locale];
  if (!catalog || !Object.prototype.hasOwnProperty.call(catalog, key)) return undefined;
  return catalog[key];
}

/**
 * Create an isolated translator instance.
 *
 * @throws TypeError when `catalogs` is empty, since there is nothing to fall
 * back to and every key would resolve to itself.
 */
export function createI18n(options: I18nOptions): I18n {
  const catalogs = options.catalogs;
  const locales = Object.keys(catalogs) as LocaleId[];
  if (locales.length === 0) {
    throw new TypeError('createI18n requires at least one catalog');
  }

  const fallbackLocale: LocaleId =
    options.fallbackLocale && catalogs[options.fallbackLocale]
      ? options.fallbackLocale
      : locales.includes(DEFAULT_FALLBACK_LOCALE)
        ? DEFAULT_FALLBACK_LOCALE
        : locales[0];

  let current: LocaleId =
    normalizeLocale(options.locale, locales) ?? fallbackLocale;
  const listeners = new Set<(locale: LocaleId) => void>();

  const t: Translate = (key, params) => {
    const message =
      lookup(catalogs, current, key) ??
      lookup(catalogs, fallbackLocale, key) ??
      options.missing?.(key, current);
    if (message === undefined) return key;
    return params ? formatMessage(message, params) : message;
  };

  return {
    get locale() {
      return current;
    },
    get fallbackLocale() {
      return fallbackLocale;
    },
    locales,
    t,
    has(key, locale = current) {
      return lookup(catalogs, locale, key) !== undefined;
    },
    setLocale(next) {
      const resolved = normalizeLocale(next, locales) ?? fallbackLocale;
      if (resolved === current) return current;
      current = resolved;
      for (const listener of listeners) {
        try {
          listener(current);
        } catch {
          // A broken subscriber must not break locale switching.
        }
      }
      return current;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
