import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseReliefWebDisastersRss } from '../scripts/seed-climate-disasters.mjs';
import { RELIEFWEB_CLIMATE_RSS, CLIMATE_NEWS_FEEDS } from '../scripts/seed-climate-news.mjs';

const NOW = Date.parse('2026-09-25T00:00:00Z');

function item({ title, link, pubDate, glide, country }) {
  const tags = [
    country ? `&lt;div class="tag country"&gt;${country}&lt;/div&gt;` : '',
    glide ? `&lt;div class="tag glide"&gt;Glide: ${glide}&lt;/div&gt;` : '',
  ].join('\n');
  return `<item>
      <title>${title}</title>
      <link>${link}</link>
      <pubDate>${pubDate}</pubDate>
      <description>${tags}&lt;p&gt;Body text.&lt;/p&gt;</description>
    </item>`;
}

const feed = (...items) => `<?xml version="1.0"?><rss><channel><title>ReliefWeb - Disasters</title>${items.join('')}</channel></rss>`;

describe('ReliefWeb disasters RSS fallback', () => {
  it('maps a GLIDE-coded flood to a canonical disaster', () => {
    const [d] = parseReliefWebDisastersRss(feed(item({
      title: 'Mozambique: Floods - Sep 2026',
      link: 'https://reliefweb.int/disaster/fl-2026-000180-moz',
      pubDate: 'Tue, 01 Sep 2026 00:00:00 +0000',
      glide: 'FL-2026-000180-MOZ',
      country: 'Affected country: Mozambique',
    })), NOW);
    assert.equal(d.id, 'reliefweb-FL-2026-000180-MOZ');
    assert.equal(d.type, 'flood');
    assert.equal(d.countryCode, 'MZ');
    assert.equal(d.status, 'ongoing');
    assert.equal(d.source, 'ReliefWeb');
    assert.equal(d.sourceUrl, 'https://reliefweb.int/disaster/fl-2026-000180-moz');
    assert.equal(d.startedAt, Date.parse('2026-09-01T00:00:00Z'));
  });

  it('treats a flash flood (FF) as a flood and a tropical cyclone (TC) as a cyclone', () => {
    const out = parseReliefWebDisastersRss(feed(
      item({ title: 'Pakistan: Flash Floods - Aug 2026', link: 'https://reliefweb.int/d/1', pubDate: 'Sat, 29 Aug 2026 00:00:00 +0000', glide: 'FF-2026-000170-PAK' }),
      item({ title: 'Philippines: Typhoon X - Sep 2026', link: 'https://reliefweb.int/d/2', pubDate: 'Sat, 12 Sep 2026 00:00:00 +0000', glide: 'TC-2026-000175-PHL' }),
    ), NOW);
    assert.deepEqual(out.map((d) => [d.type, d.countryCode]), [['flood', 'PK'], ['cyclone', 'PH']]);
  });

  it('skips types outside the five climate types, stale items and unlocatable items', () => {
    const out = parseReliefWebDisastersRss(feed(
      item({ title: 'Bangladesh: Dengue Outbreak - Sep 2026', link: 'https://reliefweb.int/d/3', pubDate: 'Tue, 01 Sep 2026 00:00:00 +0000', glide: 'EP-2026-000174-BGD' }),
      item({ title: 'Kenya: Floods - Jan 2025', link: 'https://reliefweb.int/d/4', pubDate: 'Wed, 01 Jan 2025 00:00:00 +0000', glide: 'FL-2025-000001-KEN' }),
      item({ title: 'Floods somewhere', link: 'https://reliefweb.int/d/5', pubDate: 'Tue, 01 Sep 2026 00:00:00 +0000' }),
    ), NOW);
    assert.deepEqual(out, []);
  });

  it('falls back to the title for type and to the country tag when there is no GLIDE', () => {
    const [d] = parseReliefWebDisastersRss(feed(item({
      title: 'Chile: Wildfires - Sep 2026',
      link: 'https://reliefweb.int/d/6',
      pubDate: 'Tue, 01 Sep 2026 00:00:00 +0000',
      country: 'Affected countries: Chile, Argentina',
    })), NOW);
    assert.equal(d.type, 'wildfire');
    assert.equal(d.countryCode, 'CL');
    assert.match(d.id, /^reliefweb-/);
  });
});

describe('ReliefWeb climate news RSS fallback', () => {
  it('uses the public RSS with the same climate theme as the API query', () => {
    assert.match(RELIEFWEB_CLIMATE_RSS, /^https:\/\/reliefweb\.int\/updates\/rss\.xml\?/);
    assert.match(decodeURIComponent(RELIEFWEB_CLIMATE_RSS), /\(T4590\)/);
    assert.ok(CLIMATE_NEWS_FEEDS.some((f) => f.sourceName === 'ReliefWeb Disasters' && f.isApi));
  });
});
