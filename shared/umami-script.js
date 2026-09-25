/**
 * The Umami tracker loader switch — the SINGLE implementation for every surface
 * that emits the tracker: the dashboard facade (`src/services/analytics.ts`),
 * the /pro static pages (`pro-test/vite.config.ts`), the generated use-case and
 * research pages (`scripts/build-use-cases.mjs`, `scripts/build-research-reports.mjs`)
 * and the server-rendered brief magazine (`server/_shared/brief-render.js`).
 *
 * `VITE_UMAMI_SCRIPT_SRC` unset or empty keeps the hosted collector, so hosted
 * behaviour is unchanged. A self-hosted deployment sets it to `off` and no
 * surface loads the tracker. Only the explicit word disables it: an empty
 * value is what an undeclared-but-referenced build ARG can produce, and must
 * not silently switch hosted analytics off. Without it, every page view on a private
 * deployment still fetches the vendor's script — `data-domains` stops it
 * recording, but not loading.
 *
 * A custom URL is honoured too, but only the URL changes: `data-website-id`
 * still names the hosted site, so pointing at your own Umami needs a new id.
 */

export const DEFAULT_UMAMI_SCRIPT_SRC = 'https://abacus.worldmonitor.app/script.js';

const DEFAULT_SRC_PATTERN = DEFAULT_UMAMI_SCRIPT_SRC.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const UMAMI_TAG_PATTERN = new RegExp(
  `<script\\b[^>]*\\bsrc="${DEFAULT_SRC_PATTERN}"[^>]*>\\s*</script>`,
  'g',
);

/**
 * @param {string | null | undefined} raw
 * @returns {string} the tracker URL, or '' when the tracker is disabled
 */
export function resolveUmamiScriptSrc(raw) {
  const value = raw === undefined || raw === null ? '' : String(raw).trim();
  if (value === '') return DEFAULT_UMAMI_SCRIPT_SRC;
  return value.toLowerCase() === 'off' ? '' : value;
}

/**
 * Rewrite every `<script>` that loads the default tracker so it loads `src`
 * instead — or remove it outright when `src` is ''. Works on a single tag
 * constant or on a whole HTML document.
 *
 * @param {string} html
 * @param {string} src a value returned by resolveUmamiScriptSrc
 * @returns {string}
 */
export function rewriteUmamiScriptTags(html, src) {
  if (src === DEFAULT_UMAMI_SCRIPT_SRC) return html;
  return html.replace(UMAMI_TAG_PATTERN, (tag) =>
    src === '' ? '' : tag.replace(DEFAULT_UMAMI_SCRIPT_SRC, src),
  );
}
