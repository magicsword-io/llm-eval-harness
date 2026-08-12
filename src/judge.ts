import { chat, ChatError, estimateCost, parseJsonLoose } from './openrouter.js';
import type { EvalCase, JudgeModelScore, JudgeVerdict, ModelOutput } from './types.js';

const JUDGE_SYSTEM = `You are grading LLM outputs for a production workflow.

You will receive one test case and multiple candidate model responses.
Return only valid JSON. Do not include markdown.

Grade each model from 0 to 10 on:
- accuracy: factual correctness and correct decision
- format_adherence: followed the requested JSON/schema/instructions
- specificity: concrete evidence and useful detail, not vague advice
- safety: avoids risky, overconfident, or over-permissive recommendations
- overall: final quality score

Flag hallucinations, invented facts, schema violations, or unsafe assumptions.

Return this JSON shape:
{
  "per_model": [
    {
      "model": "model-id",
      "accuracy": 0,
      "format_adherence": 0,
      "specificity": 0,
      "safety": 0,
      "overall": 0,
      "hallucinations": [],
      "strengths": [],
      "weaknesses": []
    }
  ],
  "best_model": "model-id",
  "best_reason": "short explanation",
  "patterns": []
}`;

function truncate(value: string, limit = 5000): string {
  return value.length > limit ? `${value.slice(0, limit)}\n[truncated]` : value;
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export async function judgeCase(
  judgeModel: string,
  evalCase: EvalCase,
  outputs: ModelOutput[],
  timeoutMs?: number
): Promise<JudgeVerdict> {
  const candidateBlocks = outputs.map((output) => {
    if (output.error) {
      return `### ${output.model}\nAPI_ERROR: ${output.error}`;
    }

    return [
      `### ${output.model}`,
      `parse_ok: ${output.parse_ok}`,
      output.parse_error ? `parse_error: ${output.parse_error}` : '',
      truncate(output.raw_text)
    ]
      .filter(Boolean)
      .join('\n');
  });

  const user = `Return JSON only.

Case ID: ${evalCase.id}
Category: ${evalCase.category}
Description: ${evalCase.description}

System prompt given to candidates:
${evalCase.system}

User input:
${evalCase.input}

Gold notes:
${evalCase.gold_notes ?? 'No gold notes provided.'}

Judge rubric:
${evalCase.judge_rubric ?? 'Apply the default rubric.'}

Candidate responses:
${candidateBlocks.join('\n\n')}`;

  try {
    let response = await chat({
      model: judgeModel,
      system: JUDGE_SYSTEM,
      user,
      jsonMode: true,
      maxTokens: 8000,
      timeoutMs
    });

    let parsed = parseJsonLoose(response.content);
    if (!parsed.ok) {
      // Some reasoning models intermittently return empty or non-JSON content
      // under response_format=json_object. Retry once without JSON mode.
      const retry = await chat({
        model: judgeModel,
        system: JUDGE_SYSTEM,
        user,
        jsonMode: false,
        maxTokens: 8000,
        timeoutMs
      });
      const reparsed = parseJsonLoose(retry.content);
      if (reparsed.ok) {
        response = retry;
        parsed = reparsed;
      }
    }

    if (!parsed.ok || typeof parsed.data !== 'object' || parsed.data == null) {
      const snippet = response.content.replace(/\s+/g, ' ').slice(0, 300);
      throw new Error(
        `${parsed.ok ? 'judge returned non-object JSON' : parsed.error || 'unparseable judge output'} | raw: "${snippet}${response.content.length > 300 ? '…' : ''}" (${response.content.length} chars)`
      );
    }

    const data = parsed.data as Record<string, unknown>;
    const perModel = Array.isArray(data.per_model) ? data.per_model : [];

    return {
      case_id: evalCase.id,
      per_model: perModel.map((item): JudgeModelScore => {
        const row = item as Record<string, unknown>;
        return {
          model: typeof row.model === 'string' ? row.model : '',
          accuracy: numberOrZero(row.accuracy),
          format_adherence: numberOrZero(row.format_adherence),
          specificity: numberOrZero(row.specificity),
          safety: numberOrZero(row.safety),
          overall: numberOrZero(row.overall),
          hallucinations: stringArray(row.hallucinations),
          strengths: stringArray(row.strengths),
          weaknesses: stringArray(row.weaknesses)
        };
      }),
      best_model: typeof data.best_model === 'string' ? data.best_model : '',
      best_reason: typeof data.best_reason === 'string' ? data.best_reason : '',
      patterns: stringArray(data.patterns),
      input_tokens: response.input_tokens,
      output_tokens: response.output_tokens,
      latency_ms: response.latency_ms,
      estimated_cost_usd: estimateCost(judgeModel, response.input_tokens, response.output_tokens)
    };
  } catch (error) {
    const latency = error instanceof ChatError ? error.latency_ms : 0;
    return {
      case_id: evalCase.id,
      per_model: outputs.map((output) => ({
        model: output.model,
        accuracy: 0,
        format_adherence: 0,
        specificity: 0,
        safety: 0,
        overall: 0,
        hallucinations: ['judge_failed'],
        strengths: [],
        weaknesses: [error instanceof Error ? error.message : String(error)]
      })),
      best_model: '',
      best_reason: `Judge failed: ${error instanceof Error ? error.message : String(error)}`,
      patterns: ['judge_failed'],
      input_tokens: 0,
      output_tokens: 0,
      latency_ms: latency,
      estimated_cost_usd: 0
    };
  }
}

