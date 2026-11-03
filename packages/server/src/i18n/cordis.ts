/**
 * Edge between the standalone i18n core and DSH's `ctx.locale` service.
 *
 * The service is optional: when the host does not expose it (older builds,
 * unit tests, plain browser context) callers still get a working `t` backed by
 * the local catalogs.
 */

import { createI18n } from './core.js';
import type {
  CatalogSet,
  LocaleId,
  LocaleServiceHost,
  LocaleServiceLike,
  Translate,
} from './types.js';

export interface CordisLocaleBinding {
  /** Translator bound to the host namespace, or a standalone fallback. */
  readonly t: Translate;
  /** Locales that were successfully registered with the host service. */
  readonly registered: readonly string[];
  /** Whether the host's `bind()` produced the translator. */
  readonly bound: boolean;
  /** Release every registration created by this binding. */
  dispose(): void;
}

function isLocaleService(value: unknown): value is LocaleServiceLike {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as LocaleServiceLike).register === 'function'
  );
}

/** Read the locale service from a Cordis context (`ctx.get('locale')`) or plain object. */
export function getLocaleService(host: unknown): LocaleServiceLike | undefined {
  if (!host || typeof host !== 'object') return undefined;
  const candidate = host as LocaleServiceHost;
  let service: unknown = candidate.locale;
  if (typeof candidate.get === 'function') {
    try {
      service = candidate.get('locale');
    } catch {
      // Host service unavailable (plugin not injected yet) — fall back to the property.
    }
  }
  return isLocaleService(service) ? service : undefined;
}

/**
 * Base-language aliases for region locales (`zh-CN` -> `zh`), so hosts that
 * report a bare language code still resolve a catalog.
 */
function aliasesFor(locale: LocaleId): string[] {
  const base = locale.split('-')[0];
  return base === locale ? [] : [base];
}

/**
 * Register every catalog with the host locale service and return a translator.
 *
 * Registration failures are tolerated per locale; the returned `t` always
 * works because it falls back to the local catalogs.
 */
export function bindCordisLocale(
  localeService: LocaleServiceLike | null | undefined,
  namespace: string,
  catalogs: CatalogSet,
  fallbackLocale?: LocaleId
): CordisLocaleBinding {
  const disposers: Array<() => void> = [];
  const registered: string[] = [];
  const local = createI18n({ catalogs, fallbackLocale });

  let bound = false;
  let t: Translate = local.t;

  if (localeService) {
    for (const locale of Object.keys(catalogs) as LocaleId[]) {
      const messages = catalogs[locale];
      if (!messages) continue;
      for (const id of [locale, ...aliasesFor(locale)]) {
        try {
          const dispose = localeService.register(namespace, id, messages);
          registered.push(id);
          if (typeof dispose === 'function') disposers.push(dispose);
        } catch {
          // Keep registering the remaining locales.
        }
      }
    }

    if (typeof localeService.bind === 'function') {
      try {
        t = localeService.bind(namespace);
        bound = true;
      } catch {
        // Fall back to local catalogs.
      }
    }
  }

  return {
    t,
    registered,
    bound,
    dispose() {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose();
        } catch {
          // Ignore host disposal failures.
        }
      }
    },
  };
}
