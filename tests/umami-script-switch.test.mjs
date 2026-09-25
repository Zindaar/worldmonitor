// The Umami loader switch in shared/umami-script.js. Unset must leave hosted
// behaviour byte-identical; `off` must remove the tracker from every surface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_UMAMI_SCRIPT_SRC,
  resolveUmamiScriptSrc,
  rewriteUmamiScriptTags,
} from '../shared/umami-script.js';

const TAG =
  '<script async defer src="https://abacus.worldmonitor.app/script.js" '
  + 'data-website-id="e8800335-16bc-4241-a133-0eb28c07c832" nonce="wm-static-bootstrap"></script>';

test('unset or blank resolves to the hosted collector', () => {
  for (const raw of [undefined, null, '', '   ']) {
    assert.equal(resolveUmamiScriptSrc(raw), DEFAULT_UMAMI_SCRIPT_SRC, `raw=${JSON.stringify(raw)}`);
  }
});

test('"off" disables the tracker, case- and whitespace-insensitively', () => {
  for (const raw of ['off', 'OFF', ' Off ']) {
    assert.equal(resolveUmamiScriptSrc(raw), '', `raw=${JSON.stringify(raw)}`);
  }
});

test('a custom URL is honoured', () => {
  assert.equal(resolveUmamiScriptSrc(' https://umami.example/script.js '), 'https://umami.example/script.js');
});

test('the default source leaves HTML byte-identical', () => {
  const html = `<head>${TAG}</head>`;
  assert.equal(rewriteUmamiScriptTags(html, DEFAULT_UMAMI_SCRIPT_SRC), html);
});

test('off removes every tracker tag and nothing else', () => {
  const html = `<head><title>x</title>\n    ${TAG}\n<script src="/app.js"></script></head><body>${TAG}</body>`;
  const out = rewriteUmamiScriptTags(html, '');
  assert.ok(!out.includes('abacus.worldmonitor.app'), out);
  assert.ok(out.includes('<script src="/app.js"></script>'));
  assert.ok(out.includes('<title>x</title>'));
});

test('off turns a single tag constant into an empty string', () => {
  assert.equal(rewriteUmamiScriptTags(TAG, ''), '');
});

test('a custom source swaps only the URL', () => {
  const out = rewriteUmamiScriptTags(TAG, 'https://umami.example/script.js');
  assert.equal(out, TAG.replace(DEFAULT_UMAMI_SCRIPT_SRC, 'https://umami.example/script.js'));
});

test('multi-line tags as written in the /pro HTML are matched', () => {
  const html = '<script async defer src="https://abacus.worldmonitor.app/script.js"\n  data-website-id="x"></script>';
  assert.equal(rewriteUmamiScriptTags(html, ''), '');
});
