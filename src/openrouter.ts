const BASE_URL = 'https://openrouter.ai/api/v1';
const APP_TITLE = 'LLM Eval Harness';
const SITE_URL = process.env.SITE_URL ?? 'https://example.com';

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  jsonMode?: boolean;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface ChatResult {
  content: string;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  model_returned?: string;
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  model?: string;
}

interface OpenRouterModel {
  id: string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
}

interface ModelsResponse {
  data?: OpenRouterModel[];
}

export class ChatError extends Error {
  constructor(
    message: string,
    public readonly latency_ms: number,
    public readonly kind: 'data_policy' | 'timeout' | 'api' = 'api'
  ) {
    super(message);
    this.name = 'ChatError';
  }
}

export function isDataPolicyBlock(text: string): boolean {
  return text.includes('guardrail restrictions and data policy') || text.includes('data policy');
}

const FALLBACK_PRICING: Record<string, { input: number; output: number }> = {
  'openrouter/auto': { input: 3, output: 15 },
  'google/gemini-2.5-flash-lite': { input: 0.1, output: 0.4 },
  'google/gemini-3.1-flash-lite-preview': { input: 0.3, output: 2.5 },
  'google/gemini-3-flash-preview': { input: 0.5, output: 3 },
  'x-ai/grok-4.1-fast': { input: 0.2, output: 0.5 }
};

let livePricing: Map<string, { input: number; output: number; source: 'live' | 'fallback' }> | null = null;

export async function chat(opts: ChatOptions): Promise<ChatResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new ChatError('OPENROUTER_API_KEY is not set', 0);

  const timeoutMs = opts.timeoutMs ?? Number(process.env.LLM_EVAL_TIMEOUT_MS ?? 60_000);
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const start = Date.now();
  try {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: [
        { role: 'system', content: opts.system },
        { role: 'user', content: opts.user }
      ],
      temperature: opts.temperature ?? 0,
      max_tokens: opts.maxTokens ?? 2000
    };

    if (opts.jsonMode) body.response_format = { type: 'json_object' };

    const response = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': SITE_URL,
        'X-Title': APP_TITLE
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });

    const latency_ms = Date.now() - start;
    const text = await response.text();

    if (!response.ok) {
      if (isDataPolicyBlock(text)) {
        throw new ChatError(
          `BLOCKED by OpenRouter data policy: no endpoints for this model satisfy your account's Zero Data Retention / provider restrictions. Allow providers at https://openrouter.ai/settings/privacy or pick another model.`,
          latency_ms,
          'data_policy'
        );
      }
      throw new ChatError(`OpenRouter ${response.status} after ${(latency_ms / 1000).toFixed(1)}s: ${text.slice(0, 500)}`, latency_ms);
    }

    const json = JSON.parse(text) as OpenRouterResponse;
    return {
      content: json.choices?.[0]?.message?.content ?? '',
      input_tokens: json.usage?.prompt_tokens ?? 0,
      output_tokens: json.usage?.completion_tokens ?? 0,
      latency_ms,
      model_returned: json.model
    };
  } catch (error) {
    if (error instanceof ChatError) throw error;
    const latency_ms = Date.now() - start;
    if (timedOut) throw new ChatError(`client timeout after ${(latency_ms / 1000).toFixed(1)}s`, latency_ms, 'timeout');
    throw new ChatError(`request error after ${(latency_ms / 1000).toFixed(1)}s: ${(error as Error).message}`, latency_ms);
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadLivePricing(): Promise<{ count: number; error?: string }> {
  if (livePricing) return { count: livePricing.size };

  try {
    const headers: Record<string, string> = {
      'HTTP-Referer': SITE_URL,
      'X-Title': APP_TITLE
    };
    if (process.env.OPENROUTER_API_KEY) headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const response = await fetch(`${BASE_URL}/models`, { headers, signal: controller.signal }).finally(() => clearTimeout(timeout));

    if (!response.ok) {
      livePricing = new Map();
      return { count: 0, error: `models endpoint returned ${response.status}` };
    }

    const json = (await response.json()) as ModelsResponse;
    const map = new Map<string, { input: number; output: number; source: 'live' | 'fallback' }>();
    for (const model of json.data ?? []) {
      const input = Number(model.pricing?.prompt);
      const output = Number(model.pricing?.completion);
      if (Number.isFinite(input) && Number.isFinite(output)) {
        map.set(model.id, { input: input * 1_000_000, output: output * 1_000_000, source: 'live' });
      }
    }
    livePricing = map;
    return { count: map.size };
  } catch (error) {
    livePricing = new Map();
    return { count: 0, error: (error as Error).message };
  }
}

export function getLiveModelIds(): Set<string> | null {
  return livePricing && livePricing.size > 0 ? new Set(livePricing.keys()) : null;
}

export function getModelPricing(model: string): { input: number; output: number; source: 'live' | 'fallback' } | null {
  if (livePricing?.has(model)) return livePricing.get(model)!;
  const fallback = FALLBACK_PRICING[model];
  if (fallback) return { ...fallback, source: 'fallback' };
  return null;
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = getModelPricing(model);
  if (!pricing) return 0;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

export function parseJsonLoose(raw: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch {
    // Continue with loose parsing.
  }

  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    return { ok: true, data: JSON.parse(stripped) };
  } catch {
    // Continue with object extraction.
  }

  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return { ok: true, data: JSON.parse(stripped.slice(first, last + 1)) };
    } catch (error) {
      return { ok: false, error: (error as Error).message };
    }
  }

  return { ok: false, error: 'no JSON object found' };
}

