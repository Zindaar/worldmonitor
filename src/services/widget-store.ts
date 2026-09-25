import { loadFromStorage, saveToStorage } from '@/utils';
import { safeStorageGet } from '@/utils/safe-storage';
import { clearPanelColSpanEntry, clearPanelSpanEntry } from '@/utils/panel-storage';
import { getAuthState } from '@/services/auth-state';
import { isEntitled, getEntitlementState } from '@/services/entitlements';
import {
  clearLegacyKeyStorage,
  migrateLegacyKeysToHttpOnlySession,
  readLegacySessionKey,
} from '@/services/browser-key-session';
import { subscribeWmKeyAccess } from '@/services/wm-session';

const STORAGE_KEY = 'wm-custom-widgets';
const MAX_WIDGETS = 10;
const MAX_HISTORY = 10;
const MAX_HTML_CHARS = 50_000;
const MAX_HTML_CHARS_PRO = 80_000;

type WidgetSanitizer = Pick<typeof import('@/utils/widget-sanitizer'), 'sanitizeWidgetHtml'>;

let widgetSanitizerPromise: Promise<WidgetSanitizer> | null = null;

function getWidgetSanitizer(): Promise<WidgetSanitizer> {
  widgetSanitizerPromise ??= import('@/utils/widget-sanitizer').catch((error) => {
    widgetSanitizerPromise = null;
    throw error;
  });
  return widgetSanitizerPromise;
}

function proHtmlKey(id: string): string {
  return `wm-pro-html-${id}`;
}

export interface CustomWidgetSpec {
  id: string;
  title: string;
  html: string;
  prompt: string;
  tier: 'basic' | 'pro';
  accentColor: string | null;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: number;
  updatedAt: number;
}

function materializeWidgets(raw: unknown, strict: boolean): CustomWidgetSpec[] {
  if (!Array.isArray(raw)) {
    if (strict) throw new Error('Stored custom widgets must be an array');
    return [];
  }

  const result: CustomWidgetSpec[] = [];
  for (const candidate of raw) {
    if (
      typeof candidate !== 'object' ||
      candidate === null ||
      typeof (candidate as Partial<CustomWidgetSpec>).id !== 'string'
    ) {
      if (strict) throw new Error('Stored custom widget is malformed');
      continue;
    }
    const w = candidate as CustomWidgetSpec;
    // Legacy widgets predate the `tier` field (added after custom widgets
    // shipped) and have no `tier` key at all. Both loaders normalize a
    // missing/invalid tier to 'basic' rather than dropping the widget from
    // the dashboard.
    const tier = w.tier === 'pro' ? 'pro' : 'basic';
    if (tier === 'pro') {
      const sideKeyHtml = safeStorageGet(proHtmlKey(w.id));
      const storedHtml = typeof w.html === 'string' ? w.html : '';
      const proHtml = storedHtml || sideKeyHtml;
      if (!proHtml) {
        if (strict) throw new Error('Stored Pro widget is missing HTML');
        // HTML missing — drop widget and clean up spans
        clearPanelSpanEntry(w.id);
        clearPanelColSpanEntry(w.id);
        continue;
      }
      result.push({ ...w, tier, html: proHtml });
    } else {
      if (strict && typeof w.html !== 'string') {
        throw new Error('Stored basic widget is missing HTML');
      }
      result.push({ ...w, tier: 'basic' });
    }
  }
  return result;
}

export function loadWidgets(): CustomWidgetSpec[] {
  return materializeWidgets(loadFromStorage<unknown>(STORAGE_KEY, []), false);
}

/**
 * Activation-cohort reads must distinguish a genuinely empty widget list from
 * unavailable or malformed storage. The regular loader intentionally degrades
 * those failures to `[]` for dashboard resilience.
 */
export function loadWidgetsStrict(): CustomWidgetSpec[] {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  return materializeWidgets(parsed, true);
}

export async function saveWidget(spec: CustomWidgetSpec): Promise<void> {
  if (spec.tier === 'pro') {
    const proHtml = spec.html.slice(0, MAX_HTML_CHARS_PRO);
    const meta: CustomWidgetSpec = {
      ...spec,
      html: proHtml,
      conversationHistory: spec.conversationHistory.slice(-MAX_HISTORY),
    };
    const existing = loadFromStorage<CustomWidgetSpec[]>(STORAGE_KEY, []).filter(w => w.id !== spec.id);
    const updated = [...existing, meta].slice(-MAX_WIDGETS);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
      try { localStorage.removeItem(proHtmlKey(spec.id)); } catch { /* ignore legacy side-key cleanup */ }
    } catch {
      throw new Error('Storage quota exceeded saving PRO widget');
    }
  } else {
    const { sanitizeWidgetHtml } = await getWidgetSanitizer();
    const trimmed: CustomWidgetSpec = {
      ...spec,
      tier: 'basic',
      html: sanitizeWidgetHtml(spec.html.slice(0, MAX_HTML_CHARS)),
      conversationHistory: spec.conversationHistory.slice(-MAX_HISTORY),
    };
    const existing = loadWidgets().filter(w => w.id !== trimmed.id);
    const updated = [...existing, trimmed].slice(-MAX_WIDGETS);
    saveToStorage(STORAGE_KEY, updated);
  }
}

export function deleteWidget(id: string): void {
  const updated = loadFromStorage<CustomWidgetSpec[]>(STORAGE_KEY, []).filter(w => w.id !== id);
  saveToStorage(STORAGE_KEY, updated);
  try { localStorage.removeItem(proHtmlKey(id)); } catch { /* ignore */ }
  clearPanelSpanEntry(id);
  clearPanelColSpanEntry(id);
}

export function getWidget(id: string): CustomWidgetSpec | null {
  return loadWidgets().find(w => w.id === id) ?? null;
}

// ── Browser tester key helpers ─────────────────────────────────────────────
// Legacy wm-widget-key / wm-pro-key values used to live in localStorage and
// JS-readable cookies. New writes go to /api/wm-session, which sets short-lived
// HttpOnly cookies. We keep only a tab-local hint so current-page flows can
// update immediately without re-exposing the raw key after reload.

let widgetSessionHint = false;
let proSessionHint = false;
let migrationStarted = false;
const accessListeners = new Set<() => void>();

function notifyAccessChanged(): void {
  for (const listener of accessListeners) listener();
}

/** Observe tab-local tester-key changes without exposing credential values. */
export function subscribeWidgetAccess(listener: () => void): () => void {
  accessListeners.add(listener);
  return () => accessListeners.delete(listener);
}

function migrateLegacyKeyStorage(): void {
  if (migrationStarted || typeof window === 'undefined') return;
  migrationStarted = true;
  const widgetKey = readLegacySessionKey('wm-widget-key');
  const proKey = readLegacySessionKey('wm-pro-key');
  if (!widgetKey && !proKey) return;
  widgetSessionHint = !!widgetKey;
  proSessionHint = !!proKey;
  void migrateLegacyKeysToHttpOnlySession({ widgetKey, proKey })
    .catch(() => { /* retry on next boot; keep legacy storage until success */ });
}

export function setWidgetKey(key: string): void {
  const trimmed = key.trim();
  widgetSessionHint = !!trimmed;
  notifyAccessChanged();
  if (!trimmed) {
    clearLegacyKeyStorage('wm-widget-key');
    return;
  }
  void migrateLegacyKeysToHttpOnlySession({ widgetKey: trimmed })
    .catch(() => { /* caller can retry; no new JS-readable write */ });
}

export function setProKey(key: string): void {
  const trimmed = key.trim();
  proSessionHint = !!trimmed;
  notifyAccessChanged();
  if (!trimmed) {
    clearLegacyKeyStorage('wm-pro-key');
    return;
  }
  void migrateLegacyKeysToHttpOnlySession({ proKey: trimmed })
    .catch(() => { /* caller can retry; no new JS-readable write */ });
}

// The server reports on every session mint whether this browser still holds a
// valid key cookie. Upgrade-only: a mint that was already in flight when a key
// was entered can report `false` for a key this tab has just set, and a real
// revocation takes effect on the next load anyway.
subscribeWmKeyAccess((access) => {
  const widget = widgetSessionHint || access.widget;
  const pro = proSessionHint || access.pro;
  if (widget === widgetSessionHint && pro === proSessionHint) return;
  widgetSessionHint = widget;
  proSessionHint = pro;
  notifyAccessChanged();
});

const KEY_FRAGMENT_PARAMS = { pro: 'wm-pro-key', widget: 'wm-widget-key' } as const;

/**
 * Take a tester key from the URL fragment, once: `#wm-pro-key=<key>` and/or
 * `#wm-widget-key=<key>`.
 *
 * This is how a self-hosted operator unlocks Pro. Docker mode has no Clerk or
 * Convex, so no sign-in can ever grant it; the server instead accepts the
 * operator's own PRO_WIDGET_KEY / WIDGET_AGENT_KEY. A fragment is used because
 * it is never sent to the server, so the key cannot land in an access log. It
 * is stripped from the address bar before the exchange, and from then on
 * lives only in the HttpOnly cookie /api/wm-session sets and renews.
 *
 * Resolves true when a key was found and accepted.
 */
export async function consumeKeyFragment(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.location.hash) return false;
  const params = new URLSearchParams(window.location.hash.slice(1));
  const proKey = params.get(KEY_FRAGMENT_PARAMS.pro)?.trim() ?? '';
  const widgetKey = params.get(KEY_FRAGMENT_PARAMS.widget)?.trim() ?? '';
  if (!proKey && !widgetKey) return false;

  params.delete(KEY_FRAGMENT_PARAMS.pro);
  params.delete(KEY_FRAGMENT_PARAMS.widget);
  const rest = params.toString();
  try {
    window.history.replaceState(
      window.history.state,
      '',
      `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ''}`,
    );
  } catch { /* the exchange below is still worth attempting */ }

  const accepted = await migrateLegacyKeysToHttpOnlySession({
    ...(widgetKey ? { widgetKey } : {}),
    ...(proKey ? { proKey } : {}),
  }).catch(() => false);
  if (!accepted) return false;
  if (widgetKey) widgetSessionHint = true;
  if (proKey) proSessionHint = true;
  notifyAccessChanged();
  return true;
}

export function isWidgetFeatureEnabled(): boolean {
  migrateLegacyKeyStorage();
  return widgetSessionHint;
}

export function getWidgetAgentKey(): string {
  migrateLegacyKeyStorage();
  return '';
}

export function getBrowserTesterKeys(): string[] {
  const keys = [getProWidgetKey(), getWidgetAgentKey()];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of keys) {
    const key = raw.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(key);
  }
  return result;
}

export function getBrowserTesterKey(): string {
  return getBrowserTesterKeys()[0] ?? '';
}

export function isProWidgetEnabled(): boolean {
  migrateLegacyKeyStorage();
  return proSessionHint;
}

export function isProUser(): boolean {
  return (
    isWidgetFeatureEnabled() ||
    isProWidgetEnabled() ||
    getAuthState().user?.role === 'pro' ||
    isEntitled()
  );
}

/**
 * Whether `isProUser()` is answering from settled signals rather than from
 * "nothing has loaded yet".
 *
 * A false from isProUser() is ambiguous on a normal page load: Clerk is not
 * awaited, and for a signed-in user the Convex entitlement snapshot lands later
 * still, so a paying subscriber reads as free for the first seconds. Callers
 * that PERSIST a free-tier decision (the boot clamp, the dashboard-tab
 * snapshot heal) must wait for this before writing, or they overwrite a Pro
 * user's layout on every load.
 *
 * A true from isProUser() is always definitive — no signal that says "Pro"
 * needs confirmation.
 *
 * Mirrors `shouldDeferFreeTierEnforcement` in config/panels.ts, which App uses
 * for the same decision plus its grace-timer backstop. The rule is stated twice
 * rather than shared because importing config from services would close a
 * config <-> services import cycle; keep the two in sync.
 */
export function isProTierResolved(): boolean {
  if (isProUser()) return true;
  const session = getAuthState();
  if (session.isPending) return false;
  // Anonymous is a settled answer; a signed-in user still needs the snapshot.
  return session.user === null || getEntitlementState() !== null;
}

export function getProWidgetKey(): string {
  migrateLegacyKeyStorage();
  return '';
}
