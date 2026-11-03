/**
 * i18n type surface for the peripheral server package.
 *
 * Catalogs are plain flat objects (`status.RUNNING` -> label) so they can be
 * mirrored 1:1 into `locale/*.json` and shipped to the Plugin Manager.
 */

/** Locale identifiers that ship with a catalog. Extend when adding a language. */
export type LocaleId = 'en' | 'zh-CN';

/** Loose locale input accepted from configuration / the host (`en-US`, `zh`, ...). */
export type LocaleInput = string;

/** Flat message catalog: dotted key -> localized message. */
export type MessageCatalog = Readonly<Record<string, string>>;

/** Catalogs keyed by locale. Missing locales fall back to `fallbackLocale`. */
export type CatalogSet = Readonly<Partial<Record<LocaleId, MessageCatalog>>>;

/** Interpolation values for `{placeholder}` slots inside a message. */
export type MessageParams = Readonly<Record<string, string | number>>;

/** Translate one key; returns the key itself when no catalog has it. */
export type Translate = (key: string, params?: MessageParams) => string;

export interface I18nOptions {
  /** Catalogs to translate from. At least one entry is required. */
  catalogs: CatalogSet;
  /** Initial locale. Unknown values fall back to `fallbackLocale`. */
  locale?: LocaleInput | null;
  /** Locale used when the active one misses a key. Defaults to `en`. */
  fallbackLocale?: LocaleId;
  /** Optional hook to supply a message for keys missing from every catalog. */
  missing?: (key: string, locale: LocaleId) => string | undefined;
}

export interface I18n {
  /** Currently active locale. */
  readonly locale: LocaleId;
  /** Locale consulted for missing keys. */
  readonly fallbackLocale: LocaleId;
  /** Locales that have a registered catalog, in catalog declaration order. */
  readonly locales: readonly LocaleId[];
  /** Translate using the active locale. */
  t: Translate;
  /** Whether `key` exists in `locale` (defaults to the active locale). */
  has(key: string, locale?: LocaleId): boolean;
  /** Switch the active locale; returns the locale actually selected. */
  setLocale(locale: LocaleInput): LocaleId;
  /** Subscribe to locale changes; returns a disposer. */
  subscribe(listener: (locale: LocaleId) => void): () => void;
}

/**
 * Minimal structural view of DSH's `ctx.locale` service. Kept local so the
 * package does not take a hard dependency on the host client API.
 */
export interface LocaleServiceLike {
  register(namespace: string, locale: string, messages: MessageCatalog): (() => void) | void;
  bind?(namespace: string): Translate;
}

/** Anything exposing a locale service: a Cordis context or a plain object. */
export interface LocaleServiceHost {
  get?(name: string): unknown;
  locale?: unknown;
}
