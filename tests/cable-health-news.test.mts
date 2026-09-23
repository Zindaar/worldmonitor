import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';

// The module under test reaches Redis and the NGA parser at import time, so the
// pure analysis functions are bundled with those edges stubbed out. Same shape
// as tests/cable-health-client.test.mts.
async function loadModule() {
  const result = await build({
    entryPoints: ['server/worldmonitor/infrastructure/v1/get-cable-health.ts'],
    bundle: true, write: false, format: 'esm', platform: 'node', logLevel: 'silent',
    plugins: [{
      name: 'stub-edges',
      setup(b) {
        b.onResolve({ filter: /_shared\/redis$/ }, () => ({ path: 'redis', namespace: 'stub' }));
        b.onResolve({ filter: /cable-health-repair-script\.mjs$/ }, () => ({ path: 'repair', namespace: 'stub' }));
        b.onResolve({ filter: /_shared\/nga-broadcast-warnings$/ }, () => ({ path: 'nga', namespace: 'stub' }));
        b.onResolve({ filter: /_shared\/constants$/ }, () => ({ path: 'constants', namespace: 'stub' }));
        b.onResolve({ filter: /^\.\/_shared$/ }, () => ({ path: 'vshared', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => ({
          contents:
            args.path === 'redis'
              ? 'export const cachedFetchJson = async () => null; export const getCachedJson = async () => null; export const runRedisPipeline = async () => [{}]; export const setCachedJson = async () => true; export const setCachedJsonIfAbsent = async () => true;'
              : args.path === 'repair'
                ? 'export const CABLE_HEALTH_REPAIR_SCRIPT = "";'
                : args.path === 'nga'
                  ? 'export const parseNgaBroadcastWarnings = (d) => d;'
                  : args.path === 'constants'
                    ? 'export const CHROME_UA = "test-agent";'
                    : 'export const UPSTREAM_TIMEOUT_MS = 1000;',
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0]!.text).toString('base64')}`);
}

test('trailingAcronym only accepts a token that is the initials of the words before it', async () => {
  const { trailingAcronym } = await loadModule();

  // Real acronyms.
  assert.equal(trailingAcronym('australia-singapore-cable-asc'), 'asc');
  assert.equal(trailingAcronym('west-africa-cable-system-wacs'), 'wacs');
  assert.equal(trailingAcronym('southern-cross-cable-network-sccn'), 'sccn');
  assert.equal(trailingAcronym('lower-indian-ocean-network-lion'), 'lion');
  assert.equal(trailingAcronym('south-atlantic-inter-link-sail'), 'sail');

  // The trap this rule exists for: a trailing PLAIN WORD is not an acronym.
  // Accepting 'peace-cable' produced the alias /\bcable\b/, which matched every
  // headline in a cable-news feed and attached all of them to PEACE.
  assert.equal(trailingAcronym('peace-cable'), null);
  assert.equal(trailingAcronym('indigo-west'), null);
  assert.equal(trailingAcronym('tata-tgn-gulf'), null);
  assert.equal(trailingAcronym('southern-cross-next'), null);
  assert.equal(trailingAcronym('new-cross-pacific-ncp-cable-system'), null);

  // Single-token slugs have no preceding words to take initials from.
  assert.equal(trailingAcronym('faster'), null);
  assert.equal(trailingAcronym('marea'), null);
});

test('matchCableInText resolves real cables and refuses generic prose', async () => {
  const { matchCableInText } = await loadModule();

  // Curated name.
  assert.equal(matchCableInText('MAREA cable cut off Virginia')?.cableId, 'marea');

  // Auto-derived acronym and long form, both for the same cable.
  assert.equal(matchCableInText('ASC cable break disrupts Perth-Singapore')?.cableId, 'australia_singapore_cable_asc');
  assert.equal(matchCableInText('Vocus Australia-Singapore Cable Break')?.cableId, 'australia_singapore_cable_asc');

  // An acronym only counts where the text is about cables at all.
  assert.equal(matchCableInText('ASC reports quarterly earnings'), null);

  // Regression: a generic cable headline must not resolve to any cable.
  assert.equal(matchCableInText('NATO allies foil Russian subsea cable sabotage plot'), null);
  assert.equal(matchCableInText('A GUIDE to undersea cable security'), null);

  // Single-word slugs are never auto-aliased — /\bfaster\b/ would claim FASTER
  // from any sentence using the word. FASTER *is* in the curated map (written
  // for formal NGA notices), so it is gated on cable context instead.
  assert.equal(matchCableInText('Engineers restored service faster than expected'), null);
  assert.equal(matchCableInText('Apollo landing anniversary marked in Houston'), null);
  assert.equal(matchCableInText('Indigo dye exports rise sharply'), null);

  // The same ambiguous names still resolve where the text is about cables,
  // but at the lower confidence tier.
  assert.deepEqual(
    matchCableInText('FASTER cable cut between Oregon and Japan'),
    { cableId: 'faster', precision: 'acronym' },
  );
});

test('parseCableNewsFeed reads title, date and source and decodes entities', async () => {
  const { parseCableNewsFeed } = await loadModule();
  const xml = `<rss><channel>
    <item><title>ASC cable break &amp; outage</title><pubDate>Mon, 07 Sep 2026 07:00:00 GMT</pubDate><source url="x">Light Reading</source></item>
    <item><title><![CDATA[SEA-ME-WE 4 repair underway]]></title><pubDate>Tue, 08 Sep 2026 07:00:00 GMT</pubDate></item>
    <item><title></title><pubDate>Tue, 08 Sep 2026 07:00:00 GMT</pubDate></item>
  </channel></rss>`;

  const items = parseCableNewsFeed(xml);
  assert.equal(items.length, 2); // the empty-title item is dropped
  assert.equal(items[0].title, 'ASC cable break & outage');
  assert.equal(items[0].source, 'Light Reading');
  assert.equal(items[0].ts, Date.parse('Mon, 07 Sep 2026 07:00:00 GMT'));
  assert.equal(items[1].title, 'SEA-ME-WE 4 repair underway');
  assert.equal(items[1].source, 'News');
});

test('processNewsSignals emits faults for breaks and ignores routine industry news', async () => {
  const { processNewsSignals } = await loadModule();
  const now = Date.parse('2026-09-23T00:00:00Z');
  const recent = Date.parse('2026-09-22T00:00:00Z');

  const signals = processNewsSignals([
    { title: 'ASC cable break disrupts key Australia-Singapore route', ts: recent, source: 'Light Reading' },
    // Names a real cable, contains an incident word, but is routine news.
    { title: 'ACE subsea cable upgraded to deliver more than 30Tbps', ts: recent, source: 'Capacity' },
    { title: 'EllaLink branching units to connect the Brazilian Amazon', ts: recent, source: 'Developing Telecoms' },
    { title: 'Colombo Dockyard to build cable repair vessel for Global Marine', ts: recent, source: 'Shipping Telegraph' },
    // Names no cable.
    { title: 'NATO allies foil Russian subsea cable sabotage plot', ts: recent, source: 'Reuters' },
    // Undated items cannot be aged, so they can never expire — dropped.
    { title: 'MAREA cable cut off Virginia', ts: 0, source: 'Reuters' },
  ], now);

  assert.equal(signals.length, 1);
  assert.equal(signals[0].cableId, 'australia_singapore_cable_asc');
  assert.equal(signals[0].kind, 'operator_fault');
  assert.equal(signals[0].evidence[0].source, 'NEWS');
});

test('a live operator fault never renders OK, even once its score has decayed', async () => {
  const { computeHealthMap } = await loadModule();
  const now = Date.now();
  const sixteenDaysAgo = now - 16 * 86400 * 1000;

  const map = computeHealthMap([{
    cableId: 'australia_singapore_cable_asc',
    ts: sixteenDaysAgo,
    severity: 1.0,
    confidence: 0.7,
    ttlSeconds: 21 * 86400,
    kind: 'operator_fault',
    evidence: [{ source: 'NEWS', summary: 'Fault reported: ASC cable break', ts: sixteenDaysAgo }],
  }]);

  const record = map.australia_singapore_cable_asc;
  assert.ok(record, 'the cable should be present in the health map');
  // Effective score here is ~0.16, well under the 0.50 DEGRADED threshold; the
  // floor is what keeps a known break from being reported as healthy.
  assert.ok(record.score < 0.5);
  assert.equal(record.status, 'CABLE_HEALTH_STATUS_DEGRADED');

  // Past its TTL the signal is dropped entirely and the cable leaves the map,
  // which the UI renders as "no recent data" rather than a status.
  const expired = computeHealthMap([{
    cableId: 'australia_singapore_cable_asc',
    ts: now - 30 * 86400 * 1000,
    severity: 1.0, confidence: 0.7, ttlSeconds: 21 * 86400, kind: 'operator_fault',
    evidence: [{ source: 'NEWS', summary: 'old', ts: now - 30 * 86400 * 1000 }],
  }]);
  assert.equal(Object.keys(expired).length, 0);
});
