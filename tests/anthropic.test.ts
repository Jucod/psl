import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { AnthropicLlm } from '../src/llm/anthropic.js';
import type { FormulationInput } from '../src/llm/index.js';
import type { WineResult } from '../src/engine/types.js';
import { EMPTY_FILTERS } from '../src/schema/filters.js';

/**
 * The Anthropic provider, run through the real SDK against a fake HTTP
 * server: request building, structured-output parsing, retries, fallbacks
 * and cost accounting are exercised without a key and without the network.
 */

type Reply = Record<string, unknown>;

function fakeClient(replies: Reply[]) {
  const requests: Array<{ url: string; headers: Headers; body: any }> = [];
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)),
    });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected extra request');
    const status = typeof reply.__status === 'number' ? reply.__status : 200;
    return new Response(JSON.stringify(reply), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new Anthropic({ apiKey: 'test-key', fetch, maxRetries: 0 });
  return { client, requests };
}

function message(content: Reply[], extra: Reply = {}): Reply {
  return {
    id: 'msg_test', type: 'message', role: 'assistant', model: 'claude-opus-5-5',
    content, stop_reason: 'end_turn', stop_sequence: null, stop_details: null,
    usage: { input_tokens: 1000, output_tokens: 100, iterations: null },
    ...extra,
  };
}

const VALID_FILTERS = {
  ...EMPTY_FILTERS,
  appellation: 'aoc-pic-saint-loup', color: 'red', price_max: 20,
  descriptors: ['supple'], descriptors_excluded: ['tannic'], dish: 'lamb',
};

describe('Anthropic provider: filter extraction (call 1)', () => {
  it('returns the filters the model produced, through the strict schema', async () => {
    const { client, requests } = fakeClient([
      message([{ type: 'text', text: JSON.stringify(VALID_FILTERS) }]),
    ]);
    const llm = new AnthropicLlm('claude-opus-5-5', client);

    const r = await llm.extractFilters('un rouge pas trop tannique pour un gigot', 'aoc-pic-saint-loup');

    expect(r.degraded).toBe(false);
    expect(r.filters.color).toBe('red');
    expect(r.filters.descriptors_excluded).toEqual(['tannic']);

    const sent = requests[0]!;
    expect(sent.body.model).toBe('claude-opus-5-5');
    expect(sent.body.output_config.effort).toBe('low');
    expect(sent.body.output_config.format.type).toBe('json_schema');
    // Server-side fallback on refusal, opted in.
    expect(sent.body.fallbacks).toBe('default');
    expect(sent.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    // Current models reject a disabled thinking or a thinking budget.
    expect(sent.body.thinking).toBeUndefined();
  });

  it('retries once on a schema violation, append-only, then succeeds', async () => {
    const invalid = { ...VALID_FILTERS, price_min: 30, price_max: 20 };
    const { client, requests } = fakeClient([
      message([{ type: 'text', text: JSON.stringify(invalid) }]),
      message([{ type: 'text', text: JSON.stringify(VALID_FILTERS) }]),
    ]);
    const r = await new AnthropicLlm('claude-opus-5-5', client).extractFilters('x', null);

    expect(r.degraded).toBe(false);
    expect(requests).toHaveLength(2);
    // The second request starts with the first one's messages, unchanged.
    const [first, second] = [requests[0]!.body.messages, requests[1]!.body.messages];
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second.at(-1).content).toMatch(/price_min/);
  });

  it('falls back to the rule-based parser after two invalid outputs', async () => {
    const invalid = { ...VALID_FILTERS, price_min: 30, price_max: 20 };
    const { client } = fakeClient([
      message([{ type: 'text', text: JSON.stringify(invalid) }]),
      message([{ type: 'text', text: JSON.stringify(invalid) }]),
    ]);
    const r = await new AnthropicLlm('claude-opus-5-5', client)
      .extractFilters('un rose pour l apero', 'aoc-pic-saint-loup');

    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toMatch(/price_min/);
    // The degraded answer still understands the request.
    expect(r.filters.color).toBe('rose');
  });

  it('degrades on a refusal instead of reading the content', async () => {
    const { client } = fakeClient([
      message([], { stop_reason: 'refusal', stop_details: { type: 'refusal', category: null, explanation: null } }),
    ]);
    const r = await new AnthropicLlm('claude-opus-5-5', client).extractFilters('un rouge', null);
    expect(r.degraded).toBe(true);
    expect(r.degradedReason).toBe('refus du modele');
  });

  it('degrades on an API error (bad key, rate limit...) without throwing', async () => {
    const { client } = fakeClient([
      { __status: 401, type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
    ]);
    const r = await new AnthropicLlm('claude-opus-5-5', client).extractFilters('un rouge', null);
    expect(r.degraded).toBe(true);
    expect(r.filters.color).toBe('red');
  });
});

describe('Anthropic provider: cost accounting', () => {
  it('prices the tokens of the model that ran', async () => {
    const { client } = fakeClient([message([{ type: 'text', text: JSON.stringify(VALID_FILTERS) }])]);
    const r = await new AnthropicLlm('claude-opus-5-5', client).extractFilters('x', null);
    // 1000 in at $4/M + 100 out at $20/M = $0.006, at 0.92 €/$.
    expect(r.usage.cost_eur).toBeCloseTo(0.006 * 0.92, 9);
  });

  it('after a server-side fallback, bills each part at its own model rate', async () => {
    const { client } = fakeClient([
      message([{ type: 'text', text: JSON.stringify(VALID_FILTERS) }], {
        model: 'claude-opus-5',
        usage: {
          input_tokens: 2000, output_tokens: 150,
          iterations: [
            { type: 'message', model: 'claude-opus-5-5', input_tokens: 1000, output_tokens: 50,
              cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
            { type: 'fallback_message', model: 'claude-opus-5', input_tokens: 1000, output_tokens: 100,
              cache_creation: null, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
          ],
        },
      }),
    ]);
    const r = await new AnthropicLlm('claude-opus-5-5', client).extractFilters('x', null);
    const usd = (1000 * 4 + 50 * 20 + 1000 * 5 + 100 * 25) / 1e6;
    expect(r.usage.cost_eur).toBeCloseTo(usd * 0.92, 9);
    expect(r.usage.tokens_in).toBe(2000);
  });

  it('prices an unknown model like the most expensive one', async () => {
    const { client } = fakeClient([
      message([{ type: 'text', text: JSON.stringify(VALID_FILTERS) }], { model: 'claude-future-9' }),
    ]);
    const r = await new AnthropicLlm('claude-future-9', client).extractFilters('x', null);
    expect(r.usage.cost_eur).toBeCloseTo(((1000 * 10 + 100 * 50) / 1e6) * 0.92, 9);
  });
});

describe('Anthropic provider: formulation (call 2)', () => {
  const ARBOUSE: WineResult = {
    id: 'arbouse', name: "L'Arbouse", producer: 'Mas Bruguiere', producer_id: 'mas-bruguiere',
    commune: null, appellation_id: 'aoc-pic-saint-loup', color: 'red', vintage: 2024,
    abv: null, aging: null, price_eur: 20, price_as_of: '2026-09-16', organic: true,
    certification: null, blend: [], page_url: null,
    tasting_note: 'La bouche est souple et coulante, les tanins sont fondus.',
    note_source: { id: 's', type: 'producer_page', label: 'Fiche', url: 'https://example.org', authority: null, retrieved_on: '2026-09-16' },
    producer_pairings: [], level: 'wine', appellation_profile: null, score: 0.5,
    fixture: false, relevant_excerpt: null,
  };
  const input: FormulationInput = {
    search: {
      status: 'ok', refusal: null, appliedFilters: {}, relaxations: [], ranking: 'vector',
      results: [ARBOUSE], dishPairings: [], catalogSize: 15, warnings: [], undecidableFilters: [],
    },
  };

  it('keeps an answer whose quotes are literal', async () => {
    const text = "Mas Bruguiere, L'Arbouse 2024 — 20 €. « La bouche est souple et coulante, les tanins sont fondus. »";
    const { client, requests } = fakeClient([message([{ type: 'text', text }])]);
    const r = await new AnthropicLlm('claude-opus-5-5', client).formulate(input);
    expect(r.text).toBe(text);
    // The visitor's message never reaches call 2.
    expect(JSON.stringify(requests[0]!.body)).not.toMatch(/gigot|requestedFilters/);
  });

  it('replaces a reworded quote with the template', async () => {
    const { client } = fakeClient([
      message([{ type: 'text', text: "L'Arbouse : « une bouche soyeuse et des tanins de velours »" }]),
    ]);
    const r = await new AnthropicLlm('claude-opus-5-5', client).formulate(input);
    expect(r.text).not.toMatch(/velours/);
    expect(r.text).toMatch(/L'Arbouse/);
  });

  it('ignores thinking blocks and reads only the text', async () => {
    const text = "Mas Bruguiere, L'Arbouse 2024.";
    const { client } = fakeClient([
      message([{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text }]),
    ]);
    const r = await new AnthropicLlm('claude-opus-5-5', client).formulate(input);
    expect(r.text).toBe(text);
  });
});
