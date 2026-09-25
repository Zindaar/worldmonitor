// LLM_FREE_MODELS_ONLY must stop a paid model from ever being SENT, and the Ollama slot
// must reach an OpenAI-compatible gateway that lives under a base path (Kilo:
// https://api.kilo.ai/api/gateway). Drives the real code with fetch stubbed.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  getProviderCredentials,
  isLlmModelAllowed,
  ollamaChatCompletionsUrl,
} from '../server/_shared/llm.ts';

const require = createRequire(import.meta.url);
const { callLLM } = require('../scripts/lib/llm-chain.cjs');

const ENV_KEYS = [
  'LLM_FREE_MODELS_ONLY', 'OLLAMA_API_URL', 'OLLAMA_API_KEY', 'OLLAMA_MODEL',
  'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'LLM_API_URL', 'LLM_API_KEY', 'LLM_MODEL', 'LOCAL_API_MODE',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const originalFetch = globalThis.fetch;

let sent: Array<{ url: string; model: string }> = [];
beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  sent = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body || '{}'));
    sent.push({ url: String(input), model: body.model });
    return new Response(JSON.stringify({ choices: [{ message: { content: 'disaster' } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (originalEnv[k] === undefined) delete process.env[k];
    else process.env[k] = originalEnv[k];
  }
});

describe('ollamaChatCompletionsUrl', () => {
  it('keeps the Ollama /v1 path for a bare host', () => {
    assert.equal(ollamaChatCompletionsUrl('http://ollama:11434'), 'http://ollama:11434/v1/chat/completions');
    assert.equal(ollamaChatCompletionsUrl('http://ollama:11434/'), 'http://ollama:11434/v1/chat/completions');
  });
  it('appends to a gateway base path instead of discarding it', () => {
    assert.equal(ollamaChatCompletionsUrl('https://api.kilo.ai/api/gateway'), 'https://api.kilo.ai/api/gateway/chat/completions');
    assert.equal(ollamaChatCompletionsUrl('https://api.kilo.ai/api/gateway/'), 'https://api.kilo.ai/api/gateway/chat/completions');
    assert.equal(ollamaChatCompletionsUrl('http://ollama:11434/v1'), 'http://ollama:11434/v1/chat/completions');
  });
  it('leaves a full chat/completions URL alone', () => {
    assert.equal(ollamaChatCompletionsUrl('https://gw.example/x/chat/completions'), 'https://gw.example/x/chat/completions');
  });
});

describe('isLlmModelAllowed', () => {
  it('allows everything when the switch is off', () => {
    assert.equal(isLlmModelAllowed('anthropic/claude-sonnet-4.6'), true);
    process.env.LLM_FREE_MODELS_ONLY = 'false';
    assert.equal(isLlmModelAllowed('anthropic/claude-sonnet-4.6'), true);
  });
  it('allows only ids ending in :free when the switch is on', () => {
    process.env.LLM_FREE_MODELS_ONLY = 'true';
    assert.equal(isLlmModelAllowed('nvidia/nemotron-3-super-120b-a12b:free'), true);
    assert.equal(isLlmModelAllowed('kilo-auto/free'), false);
    assert.equal(isLlmModelAllowed('ollama-cloud/gemma4:31b'), false);
    assert.equal(isLlmModelAllowed(''), false);
    assert.equal(isLlmModelAllowed(undefined), false);
  });
});

describe('server getProviderCredentials under LLM_FREE_MODELS_ONLY', () => {
  beforeEach(() => {
    process.env.LOCAL_API_MODE = 'docker';
    process.env.OLLAMA_API_URL = 'https://api.kilo.ai/api/gateway';
    process.env.OLLAMA_API_KEY = 'k';
    process.env.OLLAMA_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
    process.env.LLM_FREE_MODELS_ONLY = 'true';
  });
  it('returns the gateway URL for the configured free model', () => {
    const creds = getProviderCredentials('ollama');
    assert.equal(creds?.apiUrl, 'https://api.kilo.ai/api/gateway/chat/completions');
    assert.equal(creds?.model, 'nvidia/nemotron-3-super-120b-a12b:free');
  });
  it('refuses a per-call override to a paid model', () => {
    assert.equal(getProviderCredentials('ollama', { model: 'anthropic/claude-sonnet-4.6' }), null);
  });
  it('refuses a paid generic model', () => {
    process.env.LLM_API_URL = 'https://api.kilo.ai/api/gateway/chat/completions';
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_MODEL = 'openai/gpt-5.6-luna';
    assert.equal(getProviderCredentials('generic'), null);
  });
});

describe('llm-chain callLLM under LLM_FREE_MODELS_ONLY', () => {
  beforeEach(() => {
    process.env.OLLAMA_API_URL = 'https://api.kilo.ai/api/gateway';
    process.env.OLLAMA_API_KEY = 'k';
  });
  it('sends the free model to the gateway path', async () => {
    process.env.OLLAMA_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free';
    process.env.LLM_FREE_MODELS_ONLY = 'true';
    const out = await callLLM('sys', 'user', { maxTokens: 20 });
    assert.equal(out, 'disaster');
    assert.deepEqual(sent, [{ url: 'https://api.kilo.ai/api/gateway/chat/completions', model: 'nvidia/nemotron-3-super-120b-a12b:free' }]);
  });
  it('never sends a request for a paid model', async () => {
    process.env.OLLAMA_MODEL = 'openai/gpt-5.6-luna';
    process.env.LLM_FREE_MODELS_ONLY = 'true';
    const out = await callLLM('sys', 'user', { maxTokens: 20 });
    assert.equal(out, null);
    assert.deepEqual(sent, []);
  });
});
