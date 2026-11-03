import { describe, it, expect, vi } from 'vitest';
import { createI18n, formatMessage, normalizeLocale } from '../src/i18n/core.js';
import { bindCordisLocale, getLocaleService } from '../src/i18n/cordis.js';
import {
  EN_MESSAGES,
  PERIPHERAL_CATALOGS,
  PERIPHERAL_NAMESPACE,
  ZH_MESSAGES,
  ZH_CN_MESSAGES,
} from '../src/i18n/catalog.js';
import type { LocaleId, LocaleServiceLike } from '../src/i18n/types.js';
import enJson from '../locale/en.json';
import zhJson from '../locale/zh.json';
import zhCnJson from '../locale/zh-CN.json';

const LOCALES: LocaleId[] = ['en', 'zh', 'zh-CN'];

describe('normalizeLocale', () => {
  it('matches exact locales case-insensitively', () => {
    expect(normalizeLocale('en', LOCALES)).toBe('en');
    expect(normalizeLocale('ZH-cn', LOCALES)).toBe('zh-CN');
  });

  it('drops subtags and falls back to the base language', () => {
    expect(normalizeLocale('zh-Hans-CN', LOCALES)).toBe('zh');
    expect(normalizeLocale('zh-Hans-CN', ['en', 'zh-CN'])).toBe('zh-CN');
    expect(normalizeLocale('en-US', LOCALES)).toBe('en');
    expect(normalizeLocale('zh_CN', LOCALES)).toBe('zh-CN');
  });

  it('returns undefined for unsupported or empty input', () => {
    expect(normalizeLocale('fr-FR', LOCALES)).toBeUndefined();
    expect(normalizeLocale('', LOCALES)).toBeUndefined();
    expect(normalizeLocale(undefined, LOCALES)).toBeUndefined();
  });
});

describe('formatMessage', () => {
  it('interpolates known params and keeps unknown placeholders', () => {
    expect(formatMessage('Slot {index} of {total}', { index: 3, total: 12 })).toBe(
      'Slot 3 of 12'
    );
    expect(formatMessage('Slot {index}')).toBe('Slot {index}');
    expect(formatMessage('Slot {index}', { other: 1 })).toBe('Slot {index}');
  });
});

describe('createI18n', () => {
  const catalogs = {
    en: { hello: 'Hello {name}', onlyEn: 'English only' },
    'zh-CN': { hello: '你好 {name}' },
  };

  it('translates in the active locale and falls back per key', () => {
    const i18n = createI18n({ catalogs, locale: 'zh-CN' });
    expect(i18n.locale).toBe('zh-CN');
    expect(i18n.t('hello', { name: '外设' })).toBe('你好 外设');
    expect(i18n.t('onlyEn')).toBe('English only');
  });

  it('returns the key when no catalog has it', () => {
    const i18n = createI18n({ catalogs });
    expect(i18n.t('missing.key')).toBe('missing.key');
    expect(i18n.has('missing.key')).toBe(false);
    expect(i18n.has('hello', 'zh-CN')).toBe(true);
  });

  it('supports a custom missing handler', () => {
    const i18n = createI18n({
      catalogs,
      missing: (key) => `⟪${key}⟫`,
    });
    expect(i18n.t('nope')).toBe('⟪nope⟫');
  });

  it('falls back for unknown initial locales', () => {
    const i18n = createI18n({ catalogs, locale: 'fr-FR' });
    expect(i18n.locale).toBe('en');
  });

  it('notifies subscribers only on an actual change', () => {
    const i18n = createI18n({ catalogs });
    const listener = vi.fn();
    const dispose = i18n.subscribe(listener);

    expect(i18n.setLocale('zh')).toBe('zh-CN');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith('zh-CN');

    i18n.setLocale('zh-CN');
    expect(listener).toHaveBeenCalledTimes(1);

    dispose();
    i18n.setLocale('en');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('requires at least one catalog', () => {
    expect(() => createI18n({ catalogs: {} })).toThrow(TypeError);
  });
});

describe('peripheral catalogs', () => {
  it('ships en, zh, and zh-CN with identical key sets', () => {
    expect(Object.keys(PERIPHERAL_CATALOGS).sort()).toEqual(['en', 'zh', 'zh-CN']);
    expect(Object.keys(EN_MESSAGES).sort()).toEqual(Object.keys(ZH_MESSAGES).sort());
    expect(Object.keys(ZH_MESSAGES).sort()).toEqual(Object.keys(ZH_CN_MESSAGES).sort());
  });

  it('keeps locale/*.json in sync with the TS catalogs', () => {
    expect(enJson).toEqual(EN_MESSAGES);
    expect(zhJson).toEqual(ZH_MESSAGES);
    expect(zhCnJson).toEqual(ZH_CN_MESSAGES);
  });

  it('resolves every message in every locale (no empty values)', () => {
    for (const catalog of [EN_MESSAGES, ZH_MESSAGES, ZH_CN_MESSAGES]) {
      for (const [key, value] of Object.entries(catalog)) {
        if (key === 'meta' && typeof value === 'object' && value !== null) {
          expect((value as any).title.trim().length).toBeGreaterThan(0);
          expect((value as any).description.trim().length).toBeGreaterThan(0);
        } else if (typeof value === 'string') {
          expect(value.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('supports lookup of metadata via both flat and nested properties', () => {
    const i18nEn = createI18n({ catalogs: PERIPHERAL_CATALOGS, locale: 'en' });
    expect(i18nEn.t('meta.title')).toBe('Peripheral');
    expect(i18nEn.t('title')).toBe('Peripheral');

    const i18nZh = createI18n({ catalogs: PERIPHERAL_CATALOGS, locale: 'zh' });
    expect(i18nZh.t('meta.title')).toBe('外设');
    expect(i18nZh.t('title')).toBe('外设');
  });
});

describe('bindCordisLocale', () => {
  function fakeService() {
    const dispose = vi.fn();
    const bound = vi.fn((key: string) => `bound:${key}`);
    const service: LocaleServiceLike = {
      register: vi.fn(() => dispose),
      bind: vi.fn(() => bound),
    };
    return { service, dispose, bound };
  }

  it('registers catalogs plus base-language aliases and binds the namespace', () => {
    const { service, dispose } = fakeService();
    const binding = bindCordisLocale(service, PERIPHERAL_NAMESPACE, PERIPHERAL_CATALOGS);

    expect(binding.bound).toBe(true);
    expect(binding.registered).toContain('en');
    expect(binding.registered).toContain('zh');
    expect(binding.registered).toContain('zh-CN');
    expect(binding.t('title')).toBe('bound:title');
    expect(service.register).toHaveBeenCalledWith(
      PERIPHERAL_NAMESPACE,
      'zh',
      ZH_MESSAGES
    );

    binding.dispose();
    expect(dispose).toHaveBeenCalledTimes(binding.registered.length);
  });

  it('degrades to local catalogs when no service is available', () => {
    const binding = bindCordisLocale(undefined, PERIPHERAL_NAMESPACE, PERIPHERAL_CATALOGS);
    expect(binding.bound).toBe(false);
    expect(binding.registered).toEqual([]);
    expect(binding.t('title')).toBe('Peripheral');
    expect(() => binding.dispose()).not.toThrow();
  });

  it('tolerates registration and bind failures', () => {
    const service: LocaleServiceLike = {
      register: vi.fn(() => {
        throw new Error('host down');
      }),
      bind: vi.fn(() => {
        throw new Error('host down');
      }),
    };
    const binding = bindCordisLocale(service, PERIPHERAL_NAMESPACE, PERIPHERAL_CATALOGS);
    expect(binding.bound).toBe(false);
    expect(binding.t('title')).toBe('Peripheral');
  });

  it('extracts the service from a Cordis-like context', () => {
    const { service } = fakeService();
    expect(getLocaleService({ get: (name: string) => (name === 'locale' ? service : undefined) })).toBe(
      service
    );
    expect(getLocaleService({ locale: service })).toBe(service);
    expect(getLocaleService({ get: () => undefined })).toBeUndefined();
    expect(
      getLocaleService({
        get: () => {
          throw new Error('service unavailable');
        },
      })
    ).toBeUndefined();
  });
});
