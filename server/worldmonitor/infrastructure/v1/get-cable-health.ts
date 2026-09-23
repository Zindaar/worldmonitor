import type {
  ServerContext,
  GetCableHealthRequest,
  GetCableHealthResponse,
  CableHealthRecord,
  CableHealthEvidence,
  CableHealthStatus,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';

import { cachedFetchJson, getCachedJson, runRedisPipeline, setCachedJson, setCachedJsonIfAbsent } from '../../../_shared/redis';
import { CABLE_HEALTH_REPAIR_SCRIPT } from '../../../../shared/cable-health-repair-script.mjs';
import { parseNgaBroadcastWarnings, type NgaBroadcastWarning } from '../../../_shared/nga-broadcast-warnings';
import { UPSTREAM_TIMEOUT_MS } from './_shared';
import { CHROME_UA } from '../../../_shared/constants';

// ========================================================================
// Constants
// ========================================================================

const CACHE_KEY = 'cable-health-v1';
const META_KEY = 'seed-meta:cable-health';
const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const MAX_RETAINED_AGE_MS = 90 * 60 * 1000; // Same bound as the cable health seed budget.
const NGA_CACHE_KEY = 'cable-health-nga-warnings-v2';
const NGA_CACHE_TTL = 86400; // 24h — raw NGA warnings are stable; long TTL survives relay downtime without hammering upstream

// ---- Second evidence source: cable-incident news ----
//
// WHY THIS EXISTS. NGA was the only evidence source, and NGA has stopped
// publishing. `broadcast-warn?status=A` still answers 200 with 386 "active"
// warnings, but the newest was issued 2024-05-10 — verified 2026-09-23 against
// the live API, and against its two sibling endpoints (`/current-warnings` and
// `/inforce`), which are frozen at the same date. Nothing on the caller's side
// is stale; the upstream dataset is.
//
// The consequence is not a visible error. Every NGA signal carries a TTL of 12h
// to 5 days, computeHealthMap() weights by `1 - age/ttl` and drops anything that
// reaches zero, so all 24 cable-related warnings are discarded, `cables` comes
// out {}, and every cable on the map renders "unknown" — indistinguishable from
// a healthy quiet day. A single-source design failed silently for 866 days.
//
// This adds an independent source with the same shape: a Google News RSS query
// scoped to submarine-cable incidents, joined to cables by name. No API key, and
// it reuses the identification machinery NGA already needed (CABLE_NAME_MAP),
// so a headline naming a cable produces exactly the signal kinds the health
// model already understands. NGA stays wired in: if it ever resumes, both
// sources feed the same signal list and the better evidence wins on score.
const NEWS_CACHE_KEY = 'cable-health-news-v1';
const NEWS_CACHE_TTL = 3600; // 1h — headlines move slower than this, and it keeps us well inside Google News' tolerance
const CABLE_NEWS_FEED_URL =
  'https://news.google.com/rss/search?q=' +
  encodeURIComponent('("submarine cable" OR "undersea cable" OR "subsea cable") (cut OR fault OR damage OR severed OR repair OR outage) when:21d') +
  '&hl=en-US&gl=US&ceid=US:en';

// A headline must look like an INCIDENT to become a signal, and must not look
// like routine industry news. The negative list is load-bearing: the same feed
// returns "ACE subsea cable upgraded to deliver more than 30Tbps" and "EllaLink
// branching units to connect the Brazilian Amazon", both of which name a real
// cable and would otherwise be published as faults.
const NEWS_FAULT_RE = /\b(cut|cuts|severed|sever|break|breaks|broken|breakage|fault|faults|faulty|damaged?|outage|outages|disrupt(?:ed|ion|ions)?|knocked out|sabotage[ds]?)\b/i;
const NEWS_REPAIR_RE = /\b(repair(?:s|ed|ing)?|restor(?:e|ed|ing|ation)|fix(?:ed|ing)?|splic(?:e|ed|ing)|cable ship|repair vessel)\b/i;
const NEWS_NON_INCIDENT_RE = /\b(upgrade[sd]?|upgrading|launch(?:es|ed)?|unveil(?:s|ed)?|award(?:s|ed)?|contract|deal|plans?|planned|propos(?:e|ed|al)|invest(?:s|ed|ment)?|announce(?:s|d|ment)?|build(?:s|ing)?|construct(?:s|ion)?|to connect|connects?|expand(?:s|ed|ing)?|partner(?:s|ship)?|select(?:s|ed)?|report|guide|forum|summit|conference|webinar|market|forecast|outlook|ranking)\b/i;

// Cable slugs seeded by scripts/seed-submarine-cables.mjs (CABLE_REGIONS),
// with hyphens→underscores to give the cableId the rest of this file uses.
// Kept here rather than imported so server code does not reach into scripts/;
// a slug that drifts out of date costs a missed match, never a wrong one.
const CABLE_SLUGS = [
  '2africa', 'africa-coast-to-europe-ace', 'america-movil-submarine-cable-system-1-amx-1', 'amitie',
  'apcn-2', 'apollo', 'apricot', 'arcos', 'asia-africa-europe-1-aae-1',
  'asia-america-gateway-aag-cable-system', 'asia-direct-cable-adc', 'asia-pacific-gateway-apg',
  'atlantic-crossing-1-ac-1', 'australia-japan-cable-ajc', 'australia-singapore-cable-asc',
  'baltica', 'bifrost', 'blue', 'brusa', 'c-lion1', 'curie', 'danice',
  'djibouti-africa-regional-express-1-dare-1', 'dunant', 'eastern-africa-submarine-system-eassy',
  'echo', 'ellalink', 'equiano', 'europe-india-gateway-eig', 'falcon', 'farice-1', 'faster',
  'fiber-optic-gulf-fog', 'firmina', 'flag-atlantic-1-fa-1', 'globenet', 'grace-hopper',
  'greenland-connect', 'havfrueaec-2', 'hawaiki', 'imewe', 'india-asia-xpress-iax', 'indigo-west',
  'japan-guam-australia-south-jga-s', 'jupiter', 'lower-indian-ocean-network-lion', 'mainone',
  'malbec', 'marea', 'monet', 'new-cross-pacific-ncp-cable-system', 'no-uk', 'nuvem',
  'pacific-crossing-1-pc-1', 'pacific-light-cable-network-plcn', 'peace-cable',
  'project-waterworth', 'raman', 'safe', 'sat-3wasc', 'sea-us', 'seabras-1', 'seamewe-4',
  'seamewe-5', 'seamewe-6', 'shefa-2', 'south-america-1-sam-1',
  'south-atlantic-cable-system-sacs', 'south-atlantic-inter-link-sail',
  'southeast-asia-japan-cable-2-sjc2', 'southeast-asia-japan-cable-sjc',
  'southern-cross-cable-network-sccn', 'southern-cross-next', 'tata-tgn-atlantic-south',
  'tata-tgn-gulf', 'tata-tgn-western-europe', 'the-east-african-marine-system-teams', 'topaz',
  'trans-pacific-express-tpe-cable-system', 'unity', 'west-africa-cable-system-wacs',
];

// Multi-word slugs that the two derivation rules below would still accept but
// which are too generic to match safely in a headline. Single-word slugs need no
// entry here — rule 1 excludes them all.
const UNSAFE_AUTO_ALIASES = new Set(['no-uk', 'sea-us']);

// In-memory fallback: serves stale data when both Redis and NGA are down
let fallbackCache: GetCableHealthResponse | null = null;
let inflight: Promise<GetCableHealthResponse> | null = null;

// ========================================================================
// NGA warning types
// ========================================================================

type NgaWarning = Partial<Pick<NgaBroadcastWarning, 'text' | 'issueDate'>>;

// ========================================================================
// Cable keywords and patterns
// ========================================================================

const CABLE_KEYWORDS = [
  'CABLE', 'CABLESHIP', 'CABLE SHIP', 'CABLE LAYING',
  'CABLE OPERATIONS', 'SUBMARINE CABLE', 'UNDERSEA CABLE',
  'FIBER OPTIC', 'TELECOMMUNICATIONS CABLE',
];

const FAULT_KEYWORDS = /FAULT|BREAK|CUT|DAMAGE|SEVERED|RUPTURE|OUTAGE|FAILURE/i;
const SHIP_PATTERNS = [
  /CABLESHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CABLE\s+SHIP\s+([A-Z][A-Z0-9\s\-']+)/i,
  /CS\s+([A-Z][A-Z0-9\s\-']+)/i,
  /M\/V\s+([A-Z][A-Z0-9\s\-']+)/i,
];
const ON_STATION_RE = /ON STATION|OPERATIONS IN PROGRESS|LAYING|REPAIRING|WORKING|COMMENCED/i;

// Known cable names -> cableId mapping
// IDs are TeleGeography slugs with hyphens→underscores (generated by scripts/seed-submarine-cables.mjs).
// Must be updated manually when cables are added/renamed in the seed script.
const CABLE_NAME_MAP: Record<string, string> = {
  'MAREA': 'marea',
  'GRACE HOPPER': 'grace_hopper',
  'HAVFRUE': 'havfrueaec_2',
  'AEC-2': 'havfrueaec_2',
  'FASTER': 'faster',
  'SOUTHERN CROSS': 'southern_cross_cable_network_sccn',
  'CURIE': 'curie',
  'SEA-ME-WE 6': 'seamewe_6',
  'SEA-ME-WE 5': 'seamewe_5',
  'SEA-ME-WE 4': 'seamewe_4',
  'SEA-ME-WE': 'seamewe_6',
  'SEAMEWE': 'seamewe_6',
  'SMW6': 'seamewe_6',
  'SMW5': 'seamewe_5',
  'SMW4': 'seamewe_4',
  '2AFRICA': '2africa',
  'WACS': 'west_africa_cable_system_wacs',
  'EASSY': 'eastern_africa_submarine_system_eassy',
  'SAM-1': 'south_america_1_sam_1',
  'SAM1': 'south_america_1_sam_1',
  'ELLALINK': 'ellalink',
  'ELLA LINK': 'ellalink',
  'APG': 'asia_pacific_gateway_apg',
  'INDIGO': 'indigo_west',
  'SJC': 'southeast_asia_japan_cable_sjc',
  'SJC2': 'southeast_asia_japan_cable_2_sjc2',
  'FARICE': 'farice_1',
  'FALCON': 'falcon',
  'DUNANT': 'dunant',
  'AMITIE': 'amitie',
  'APOLLO': 'apollo',
  'AC-1': 'atlantic_crossing_1_ac_1',
  'TPE': 'trans_pacific_express_tpe_cable_system',
  'NCP': 'new_cross_pacific_ncp_cable_system',
  'JUPITER': 'jupiter',
  'EQUIANO': 'equiano',
  'ACE CABLE': 'africa_coast_to_europe_ace',
  'AFRICA COAST TO EUROPE': 'africa_coast_to_europe_ace',
  'MAINONE': 'mainone',
  'SAFE CABLE': 'safe',
  'SAT-3': 'safe',
  'TEAMS CABLE': 'the_east_african_marine_system_teams',
  'EAST AFRICAN MARINE': 'the_east_african_marine_system_teams',
  'PEACE CABLE': 'peace_cable',
  'IMEWE': 'imewe',
  'AAE-1': 'asia_africa_europe_1_aae_1',
  'AAG': 'asia_america_gateway_aag_cable_system',
  'BRUSA': 'brusa',
  'MONET': 'monet',
  'FIRMINA': 'firmina',
  'ARCOS': 'arcos',
  'GLOBENET': 'globenet',
  'BIFROST': 'bifrost',
  'APRICOT': 'apricot',
  'RAMAN': 'raman',
  'FLAG': 'flag_atlantic_1_fa_1',
  'FLAG ATLANTIC': 'flag_atlantic_1_fa_1',
};

// Minimal cable geometry for proximity matching (landing coords: [lat, lon])
// IDs must match seed-submarine-cables.mjs slug-based output
const CABLE_LANDINGS: Record<string, [number, number][]> = {
  marea: [[36.85, -75.98], [43.26, -2.93]],
  grace_hopper: [[40.57, -73.97], [50.83, -4.55], [43.26, -2.93]],
  havfrueaec_2: [[40.22, -74.01], [58.15, 8.0], [55.56, 8.13]],
  dunant: [[46.69, -1.97], [36.76, -76.06]],
  amitie: [[44.89, -1.21], [50.83, -4.54], [42.46, -70.95]],
  faster: [[43.37, -124.22], [34.95, 139.95], [34.32, 136.85]],
  southern_cross_cable_network_sccn: [[-33.87, 151.21], [-36.85, 174.76], [33.74, -118.27]],
  curie: [[33.74, -118.27], [-33.05, -71.62]],
  seamewe_6: [[1.35, 103.82], [19.08, 72.88], [25.13, 56.34], [21.49, 39.19], [29.97, 32.55], [43.30, 5.37]],
  seamewe_5: [[1.35, 103.82], [19.08, 72.88], [43.30, 5.37]],
  seamewe_4: [[1.35, 103.82], [19.08, 72.88], [43.30, 5.37]],
  '2africa': [[50.83, -4.55], [38.72, -9.14], [14.69, -17.44], [6.52, 3.38], [-33.93, 18.42], [-4.04, 39.67], [21.49, 39.19], [31.26, 32.30]],
  west_africa_cable_system_wacs: [[-33.93, 18.42], [6.52, 3.38], [14.69, -17.44], [38.72, -9.14], [51.51, -0.13]],
  eastern_africa_submarine_system_eassy: [[-29.85, 31.02], [-25.97, 32.58], [-6.80, 39.28], [-4.04, 39.67], [11.59, 43.15]],
  south_america_1_sam_1: [[-22.91, -43.17], [-34.60, -58.38], [26.36, -80.08]],
  ellalink: [[38.72, -9.14], [-3.72, -38.52]],
  asia_pacific_gateway_apg: [[35.69, 139.69], [25.15, 121.44], [22.29, 114.17], [1.35, 103.82]],
  indigo_west: [[-31.95, 115.86], [1.35, 103.82], [-6.21, 106.85]],
  southeast_asia_japan_cable_sjc: [[35.69, 139.69], [36.07, 120.32], [1.35, 103.82], [22.29, 114.17]],
  farice_1: [[64.13, -21.90], [62.01, -6.77], [55.95, -3.19]],
  falcon: [[25.13, 56.34], [23.59, 58.38], [26.23, 50.59], [29.38, 47.98]],
  equiano: [[38.72, -9.14], [6.52, 3.38], [-33.93, 18.42]],
  peace_cable: [[25.13, 56.34], [-4.04, 39.67], [43.30, 5.37]],
  imewe: [[43.30, 5.37], [19.08, 72.88], [25.13, 56.34]],
  brusa: [[36.85, -75.98], [-22.91, -43.17]],
  firmina: [[36.85, -75.98], [-3.72, -38.52], [-34.60, -58.38]],
  jupiter: [[33.74, -118.27], [34.95, 139.95], [14.55, 121.0]],
  flag_atlantic_1_fa_1: [[50.04, -5.66], [40.57, -73.97], [43.30, 5.37]],
};

// ========================================================================
// Signal types
// ========================================================================

interface Signal {
  cableId: string;
  ts: number; // epoch ms
  severity: number;
  confidence: number;
  ttlSeconds: number;
  kind: string;
  evidence: Array<{ source: string; summary: string; ts: number }>;
}

// ========================================================================
// NGA fetch
// ========================================================================

async function fetchNgaWarnings(): Promise<NgaWarning[] | null> {
  try {
    const res = await fetch(
      'https://msi.nga.mil/api/publications/broadcast-warn?output=json&status=A',
      { headers: { 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
    );
    if (!res.ok) return null; // fetch failed — don't cache, let sentinel TTL govern retry
    const data = await res.json();
    return parseNgaBroadcastWarnings(data);
  } catch {
    return null; // network error — don't poison NGA cache with empty data
  }
}

// ========================================================================
// Text analysis helpers
// ========================================================================

export function isCableRelated(text: string): boolean {
  const upper = text.toUpperCase();
  return CABLE_KEYWORDS.some((kw) => upper.includes(kw));
}

export function parseCoordinates(text: string): [number, number][] {
  const coords: [number, number][] = [];
  const dms = /(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([NS])\s+(\d{1,3})-(\d{1,2}(?:\.\d+)?)\s*([EW])/gi;
  let m: RegExpExecArray | null;
  while ((m = dms.exec(text)) !== null) {
    let lat = parseInt(m[1]!, 10) + parseFloat(m[2]!) / 60;
    let lon = parseInt(m[4]!, 10) + parseFloat(m[5]!) / 60;
    if (m[3]!.toUpperCase() === 'S') lat = -lat;
    if (m[6]!.toUpperCase() === 'W') lon = -lon;
    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) coords.push([lat, lon]);
  }
  return coords;
}

const _cableNamePatterns = new Map(
  Object.entries(CABLE_NAME_MAP).map(([name, id]) => [
    new RegExp(`\\b${name.replace(/[-/]/g, '\\$&')}\\b`, 'i'),
    id,
  ]),
);

export function matchCableByName(text: string): string | null {
  for (const [pattern, id] of _cableNamePatterns) {
    if (pattern.test(text)) return id;
  }
  return null;
}

// ---- Auto-derived aliases from the seeded slug list ----
//
// CABLE_NAME_MAP is hand-maintained and covers 57 aliases across ~45 cables;
// the seeder carries 80. Rather than grow the hand map, derive aliases from the
// slugs — but only where the slug itself proves the alias is distinctive.
//
// TWO RULES, both learned from a false positive caught in testing:
//
//  1. MULTI-WORD SLUGS ONLY. A one-word slug ('faster', 'apollo', 'unity',
//     'blue', 'echo', 'safe') is indistinguishable from ordinary prose — an
//     auto-derived /\bfaster\b/ would claim a cable from any headline using the
//     word. Single-word cables stay in CABLE_NAME_MAP, where a human checked
//     that the name is safe to match.
//
//  2. AN ACRONYM MUST BE THE INITIALS OF THE WORDS BEFORE IT. The first attempt
//     took any short trailing token, which turned 'peace-cable' into the alias
//     /\bcable\b/ and attached every headline in the feed to PEACE. Requiring
//     'australia-singapore-cable-asc' -> a,s,c = "asc" keeps the real acronyms
//     (ASC, WACS, SCCN, LION, SAIL) and rejects the trailing plain words
//     ('-cable', '-west', '-gulf', '-next', '-system').
//
// When a trailing acronym IS confirmed, it is stripped from the long-form alias
// as well, so "Vocus Australia-Singapore Cable Break" matches on the name.
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The trailing slug token, when it is exactly the initials of the tokens before it. */
export function trailingAcronym(slug: string): string | null {
  const parts = slug.split('-').filter(Boolean);
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1]!;
  if (!/^[a-z]{2,6}$/.test(last)) return null;
  const initials = parts.slice(0, -1).map((p) => p[0]).join('');
  return initials === last ? last : null;
}

interface CableAlias {
  pattern: RegExp;
  cableId: string;
  /** Exact curated names are trusted more than machine-derived acronyms. */
  precision: 'name' | 'acronym';
}

function buildAutoAliases(): CableAlias[] {
  const out: CableAlias[] = [];
  for (const slug of CABLE_SLUGS) {
    if (UNSAFE_AUTO_ALIASES.has(slug)) continue;
    const parts = slug.split('-').filter(Boolean);
    if (parts.length < 2) continue; // rule 1
    const cableId = slug.replace(/-/g, '_');

    const acr = trailingAcronym(slug); // rule 2
    const nameParts = acr ? parts.slice(0, -1) : parts;
    const longForm = nameParts.join(' ');
    if (nameParts.length >= 2 && longForm.length >= 6) {
      out.push({
        pattern: new RegExp(`\\b${escapeRe(longForm).replace(/\s+/g, '[\\s-]+')}\\b`, 'i'),
        cableId,
        precision: 'name',
      });
    }
    if (acr && acr.length >= 3) {
      out.push({ pattern: new RegExp(`\\b${acr}\\b`, 'i'), cableId, precision: 'acronym' });
    }
  }
  return out;
}

const _autoAliases = buildAutoAliases();

// Curated aliases that are also ordinary English words. CABLE_NAME_MAP was
// written against NGA broadcast warnings — formal maritime notices where
// "FASTER" or "APOLLO" in running text is almost certainly the cable. News
// headlines are not that: "Engineers restored service faster than expected"
// would otherwise be filed as an incident on the FASTER cable. These aliases
// still work, but only in text that is demonstrably about cables, and they
// carry the lower 'acronym' confidence.
const AMBIGUOUS_CURATED_ALIASES = new Set([
  'FASTER', 'APOLLO', 'FLAG', 'INDIGO', 'JUPITER', 'FALCON', 'APRICOT',
  'CURIE', 'MONET', 'RAMAN', 'ARCOS', 'SAFE CABLE',
]);

const _curatedNewsAliases: CableAlias[] = Object.entries(CABLE_NAME_MAP).map(([name, cableId]) => ({
  pattern: new RegExp(`\\b${name.replace(/[-/]/g, '\\$&')}\\b`, 'i'),
  cableId,
  precision: AMBIGUOUS_CURATED_ALIASES.has(name) ? 'acronym' : 'name',
}));

/**
 * Resolve a cable from free text, for the news source.
 *
 * Unambiguous names win outright. Everything weaker — a machine-derived
 * acronym, or a curated name that is also an English word — is accepted only
 * where the text actually mentions a cable, and is reported at lower precision
 * so the caller can discount it.
 *
 * This is deliberately stricter than matchCableByName(), which NGA still uses
 * unchanged: a broadcast warning has already established its own context.
 */
export function matchCableInText(text: string): { cableId: string; precision: 'name' | 'acronym' } | null {
  const mentionsCable = /\b(cable|subsea|submarine)\b/i.test(text);
  let weakHit: { cableId: string; precision: 'acronym' } | null = null;

  for (const alias of [..._curatedNewsAliases, ..._autoAliases]) {
    if (!alias.pattern.test(text)) continue;
    if (alias.precision === 'name') return { cableId: alias.cableId, precision: 'name' };
    if (mentionsCable && !weakHit) weakHit = { cableId: alias.cableId, precision: 'acronym' };
  }
  return weakHit;
}

export function findNearestCable(lat: number, lon: number): { cableId: string; distanceKm: number } | null {
  let bestId: string | null = null;
  let bestDist = Infinity;
  const MAX_DIST_KM = 555; // ~5 degrees at equator

  const cosLat = Math.cos(lat * Math.PI / 180);

  for (const [cableId, landings] of Object.entries(CABLE_LANDINGS)) {
    for (const [lLat, lLon] of landings) {
      const dLat = (lat - lLat) * 111;
      const dLon = (lon - lLon) * 111 * cosLat;
      const distKm = Math.sqrt(dLat ** 2 + dLon ** 2);
      if (distKm < bestDist && distKm < MAX_DIST_KM) {
        bestDist = distKm;
        bestId = cableId;
      }
    }
  }

  return bestId ? { cableId: bestId, distanceKm: bestDist } : null;
}

const MONTH_MAP: Record<string, number> = {
  JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
  JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

export function parseIssueDate(dateStr: string | undefined): number {
  const m = dateStr?.match(/(\d{2})(\d{4})Z\s+([A-Z]{3})\s+(\d{4})/i);
  if (!m) return 0;
  const d = new Date(Date.UTC(
    parseInt(m[4]!, 10),
    MONTH_MAP[m[3]!.toUpperCase()] ?? 0,
    parseInt(m[1]!, 10),
    parseInt(m[2]!.slice(0, 2), 10),
    parseInt(m[2]!.slice(2, 4), 10),
  ));
  return Number.isNaN(d.getTime()) ? 0 : d.getTime();
}

function hasShipName(text: string): boolean {
  return SHIP_PATTERNS.some((pat) => pat.test(text));
}

// ========================================================================
// Signal processing
// ========================================================================

export function processNgaSignals(warnings: NgaWarning[]): Signal[] {
  const signals: Signal[] = [];
  const cableWarnings = warnings.filter((w) => isCableRelated(w.text || ''));

  for (const warning of cableWarnings) {
    const text = warning.text || '';
    const ts = parseIssueDate(warning.issueDate);
    const coords = parseCoordinates(text);

    let cableId = matchCableByName(text);
    let joinMethod = 'name';
    let distanceKm = 0;

    if (!cableId && coords.length > 0) {
      const centLat = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const centLon = coords.reduce((s, c) => s + c[1], 0) / coords.length;
      const nearest = findNearestCable(centLat, centLon);
      if (nearest) {
        cableId = nearest.cableId;
        joinMethod = 'geometry';
        distanceKm = Math.round(nearest.distanceKm);
      }
    }

    if (!cableId) continue;

    const isFault = FAULT_KEYWORDS.test(text);
    const isRepairShip = hasShipName(text);
    const isOnStation = ON_STATION_RE.test(text);

    const summaryText = text.slice(0, 150) + (text.length > 150 ? '...' : '');

    if (isFault) {
      signals.push({
        cableId,
        ts,
        severity: 1.0,
        confidence: joinMethod === 'name' ? 0.9 : Math.max(0.4, 0.8 - distanceKm / 500),
        ttlSeconds: 5 * 86400,
        kind: 'operator_fault',
        evidence: [{ source: 'NGA', summary: `Fault/damage reported: ${summaryText}`, ts }],
      });
    } else {
      signals.push({
        cableId,
        ts,
        severity: 0.6,
        confidence: joinMethod === 'name' ? 0.8 : Math.max(0.3, 0.7 - distanceKm / 500),
        ttlSeconds: 3 * 86400,
        kind: 'cable_advisory',
        evidence: [{ source: 'NGA', summary: `Cable advisory: ${summaryText}`, ts }],
      });
    }

    if (isRepairShip) {
      signals.push({
        cableId,
        ts,
        severity: isOnStation ? 0.8 : 0.5,
        confidence: isOnStation ? 0.85 : 0.6,
        ttlSeconds: isOnStation ? 24 * 3600 : 12 * 3600,
        kind: 'repair_activity',
        evidence: [{
          source: 'NGA',
          summary: isOnStation
            ? `Cable repair vessel on station: ${summaryText}`
            : `Cable ship in area: ${summaryText}`,
          ts,
        }],
      });
    }
  }

  return signals;
}

// ========================================================================
// Cable-incident news source
// ========================================================================

export interface CableNewsItem {
  title: string;
  /** epoch ms, 0 when the feed gave no parseable date */
  ts: number;
  source: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
    .trim();
}

/** Minimal RSS reader — one regex pass, no XML dependency for a 20-field feed. */
export function parseCableNewsFeed(xml: string): CableNewsItem[] {
  const items: CableNewsItem[] = [];
  for (const m of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1] ?? '';
    const rawTitle = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? '';
    const title = decodeEntities(rawTitle);
    if (!title) continue;
    const rawDate = /<pubDate\b[^>]*>([\s\S]*?)<\/pubDate>/i.exec(block)?.[1] ?? '';
    const parsed = Date.parse(decodeEntities(rawDate));
    const source = decodeEntities(/<source\b[^>]*>([\s\S]*?)<\/source>/i.exec(block)?.[1] ?? '') || 'News';
    items.push({ title, ts: Number.isNaN(parsed) ? 0 : parsed, source });
  }
  return items;
}

async function fetchCableNews(): Promise<CableNewsItem[] | null> {
  try {
    const res = await fetch(CABLE_NEWS_FEED_URL, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
    if (!res.ok) return null; // same contract as fetchNgaWarnings: never cache a failure
    const items = parseCableNewsFeed(await res.text());
    return items.length > 0 ? items : null; // an empty parse is a parse failure, not "no incidents"
  } catch {
    return null;
  }
}

/**
 * Turn cable-incident headlines into the same Signal shape NGA produces.
 *
 * Confidence is deliberately below NGA's for the equivalent claim: an NGA
 * broadcast warning is an operator notice, a headline is a report about one.
 * A clear fault headline still scores 1.0 x 0.85 = 0.85, which clears the 0.80
 * FAULT threshold while fresh and decays through DEGRADED to OK as it ages —
 * so a real cut shows as a fault, and a stale one stops shouting on its own.
 */
export function processNewsSignals(items: CableNewsItem[], now: number = Date.now()): Signal[] {
  const signals: Signal[] = [];

  for (const item of items) {
    const text = item.title;
    // A dateless item cannot be aged, and an undated fault would never expire.
    if (!item.ts) continue;
    // Guard against a feed clock ahead of ours; treat the future as now.
    const ts = Math.min(item.ts, now);

    const match = matchCableInText(text);
    if (!match) continue;

    const isFault = NEWS_FAULT_RE.test(text);
    const isRepair = NEWS_REPAIR_RE.test(text);
    if (!isFault && !isRepair) continue;
    // Routine industry news that merely contains an incident word
    // ("...repair vessel contract awarded") must not become an incident.
    if (NEWS_NON_INCIDENT_RE.test(text) && !isFault) continue;

    const acronymPenalty = match.precision === 'acronym' ? 0.15 : 0;
    const summary = `${text} (${item.source})`;

    if (isFault) {
      signals.push({
        cableId: match.cableId,
        ts,
        severity: 1.0,
        confidence: Math.max(0.3, 0.85 - acronymPenalty),
        // Much longer than NGA's 5d, because the underlying condition lasts that
        // long: a cut cable is typically weeks from repair, and reporting lags
        // the break by days. 21d matches the feed's own lookback window, so a
        // fault stays represented for as long as we can still see the headline.
        ttlSeconds: 21 * 86400,
        kind: 'operator_fault',
        evidence: [{ source: 'NEWS', summary: `Fault reported: ${summary}`, ts }],
      });
    } else {
      signals.push({
        cableId: match.cableId,
        ts,
        severity: 0.8,
        confidence: Math.max(0.3, 0.6 - acronymPenalty),
        ttlSeconds: 10 * 86400, // a repair campaign runs for days to weeks
        kind: 'repair_activity',
        evidence: [{ source: 'NEWS', summary: `Repair activity: ${summary}`, ts }],
      });
    }
  }

  return signals;
}

// ========================================================================
// Health computation
// ========================================================================

export function computeHealthMap(signals: Signal[]): Record<string, CableHealthRecord> {
  const now = Date.now();
  const byCable: Record<string, Signal[]> = {};

  for (const sig of signals) {
    if (!byCable[sig.cableId]) byCable[sig.cableId] = [];
    byCable[sig.cableId]!.push(sig);
  }

  const healthMap: Record<string, CableHealthRecord> = {};

  for (const [cableId, cableSignals] of Object.entries(byCable)) {
    const effectiveSignals: Array<Signal & { effective: number; recencyWeight: number }> = [];

    for (const sig of cableSignals) {
      const ageMs = now - sig.ts;
      const ageSec = Math.max(0, ageMs / 1000);
      const recencyWeight = Math.max(0, Math.min(1, 1 - ageSec / sig.ttlSeconds));

      if (recencyWeight <= 0) continue;

      const effective = sig.severity * sig.confidence * recencyWeight;
      effectiveSignals.push({ ...sig, effective, recencyWeight });
    }

    if (effectiveSignals.length === 0) continue;

    effectiveSignals.sort((a, b) => b.effective - a.effective);

    const topScore = effectiveSignals[0]!.effective;
    const topConfidence = effectiveSignals[0]!.confidence * effectiveSignals[0]!.recencyWeight;

    const hasOperatorFault = effectiveSignals.some(
      (s) => s.kind === 'operator_fault' && s.effective >= 0.50,
    );
    const hasRepairActivity = effectiveSignals.some(
      (s) => s.kind === 'repair_activity' && s.effective >= 0.40,
    );

    // A fault signal that is still inside its TTL means the cable is believed to
    // be damaged; the decay expresses fading CONFIDENCE in the report, not the
    // cable coming back. Without this floor a confirmed break reported 16 days
    // ago scores 0.16 and renders "OK" — a worse answer than saying nothing.
    // It decays to OK only once the signal expires entirely.
    const hasLiveOperatorFault = effectiveSignals.some((s) => s.kind === 'operator_fault');

    let status: CableHealthStatus;
    if (topScore >= 0.80 && hasOperatorFault) {
      status = 'CABLE_HEALTH_STATUS_FAULT';
    } else if (topScore >= 0.80 && hasRepairActivity) {
      status = 'CABLE_HEALTH_STATUS_DEGRADED';
    } else if (topScore >= 0.50) {
      status = 'CABLE_HEALTH_STATUS_DEGRADED';
    } else if (hasLiveOperatorFault) {
      status = 'CABLE_HEALTH_STATUS_DEGRADED';
    } else {
      status = 'CABLE_HEALTH_STATUS_OK';
    }

    const evidence: CableHealthEvidence[] = effectiveSignals
      .slice(0, 3)
      .flatMap((s) => s.evidence)
      .slice(0, 3);

    const lastUpdated = effectiveSignals
      .map((s) => s.ts)
      .sort((a, b) => b - a)[0]!;

    healthMap[cableId] = {
      status,
      score: Math.round(topScore * 100) / 100,
      confidence: Math.round(topConfidence * 100) / 100,
      lastUpdated,
      evidence,
    };
  }

  return healthMap;
}

// ========================================================================
// RPC implementation
// ========================================================================

function isUsableSnapshot(value: unknown): value is GetCableHealthResponse {
  if (!value || typeof value !== 'object'
    || !('generatedAt' in value) || typeof value.generatedAt !== 'number' || !Number.isFinite(value.generatedAt)
    || !('cables' in value) || !value.cables || typeof value.cables !== 'object' || Array.isArray(value.cables)) return false;
  const age = Date.now() - value.generatedAt;
  return age >= 0 && age < MAX_RETAINED_AGE_MS;
}

async function repairSnapshot(snapshot: GetCableHealthResponse): Promise<void> {
  const deadline = snapshot.generatedAt + MAX_RETAINED_AGE_MS;
  const encoded = JSON.stringify(snapshot);
  const metadata = { fetchedAt: snapshot.generatedAt, recordCount: Object.keys(snapshot.cables).length };
  if (process.env.LOCAL_API_MODE === 'tauri-sidecar') {
    const { sidecarCacheGet, sidecarCacheSet } = await import('../../../_shared/sidecar-cache');
    // No await between compare and writes in the single-process sidecar cache.
    const remainingSeconds = Math.floor((deadline - Date.now()) / 1000);
    if (remainingSeconds > 0 && JSON.stringify(sidecarCacheGet(CACHE_KEY)) === encoded) {
      sidecarCacheSet(CACHE_KEY, snapshot, remainingSeconds);
      sidecarCacheSet(META_KEY, metadata, 604800);
    }
    return;
  }
  const results = await runRedisPipeline([[
    'EVAL', CABLE_HEALTH_REPAIR_SCRIPT, '2', CACHE_KEY, META_KEY,
    encoded, String(deadline), JSON.stringify(metadata),
  ]]);
  const result = results?.[0];
  if (!result || result.error) console.warn('[cable-health] cache repair unconfirmed');
}

async function publishSnapshot(snapshot: GetCableHealthResponse): Promise<void> {
  const remainingSeconds = Math.floor((snapshot.generatedAt + MAX_RETAINED_AGE_MS - Date.now()) / 1000);
  if (remainingSeconds <= 0) return;
  // Metadata describes a confirmed payload, never a cache read or failed refresh.
  if (await setCachedJson(CACHE_KEY, snapshot, remainingSeconds)) {
    await repairSnapshot(snapshot);
  }
}

async function loadCableHealth(): Promise<GetCableHealthResponse> {
  const cached = await getCachedJson(CACHE_KEY);
  const retained = isUsableSnapshot(cached) ? cached : isUsableSnapshot(fallbackCache) ? fallbackCache : null;
  if (isUsableSnapshot(cached) && Date.now() - cached.generatedAt < REFRESH_INTERVAL_MS) {
    // Migrate legacy short TTLs and repair missing metadata without renewing success.
    await repairSnapshot(cached);
    fallbackCache = cached;
    return cached;
  }
  try {
    // Refresh by age while the previous canonical payload remains available to
    // health/bootstrap readers. The entire load is coalesced, including cache hits.
    //
    // Both sources are optional and independent. Either one succeeding is enough
    // to publish: when NGA went dark its null return used to abort the whole
    // refresh, so a second source that only ran after it would never have run.
    const [ngaData, newsData] = await Promise.all([
      cachedFetchJson<NgaWarning[]>(NGA_CACHE_KEY, NGA_CACHE_TTL, fetchNgaWarnings)
        .catch(() => null),
      cachedFetchJson<CableNewsItem[]>(NEWS_CACHE_KEY, NEWS_CACHE_TTL, fetchCableNews)
        .catch(() => null),
    ]);

    if (ngaData !== null || newsData !== null) {
      const signals = [
        ...(ngaData ? processNgaSignals(ngaData) : []),
        ...(newsData ? processNewsSignals(newsData) : []),
      ];
      const cables = computeHealthMap(signals);
      const result = { generatedAt: Date.now(), cables };
      await publishSnapshot(result);
      fallbackCache = result;
      return result;
    }
  } catch {
    // The retained snapshot below has the same deadline on every failed refresh.
  }
  if (isUsableSnapshot(retained)) {
    const remainingSeconds = Math.floor((retained.generatedAt + MAX_RETAINED_AGE_MS - Date.now()) / 1000);
    if (!isUsableSnapshot(cached) && remainingSeconds > 0) {
      // Repair an evicted key without overwriting a concurrent refresh or
      // changing the original success clock and retention deadline.
      await setCachedJsonIfAbsent(CACHE_KEY, retained, remainingSeconds);
    }
    await repairSnapshot(retained);
    return retained;
  }
  return { generatedAt: 0, cables: {} };
}

export async function getCableHealth(
  _ctx: ServerContext,
  _req: GetCableHealthRequest,
): Promise<GetCableHealthResponse> {
  if (inflight) return inflight;
  inflight = loadCableHealth();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
