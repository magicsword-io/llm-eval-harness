import type { RunReport } from './types.js';

const ACCURACY_TIE_BAND = 0.25;

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function rating(value: number): string {
  return value.toFixed(2);
}

function money(value: number): string {
  if (value === 0) return '$0.000000';
  if (value < 0.01) return `$${value.toFixed(6)}`;
  return `$${value.toFixed(4)}`;
}

function avgLatency(report: RunReport, model: string): number {
  const usage = report.per_model_usage[model];
  return usage.total_latency_ms / Math.max(1, report.total_cases);
}

function costPerCase(report: RunReport, model: string): number {
  const usage = report.per_model_usage[model];
  return usage.estimated_cost_usd / Math.max(1, report.total_cases);
}

function deterministicOverall(report: RunReport, model: string): number {
  let passed = 0;
  let total = 0;
  for (const testCase of report.cases) {
    const score = testCase.deterministic_scores[model];
    if (!score) continue;
    passed += score.passed_weight;
    total += score.total_weight;
  }
  return total > 0 ? passed / total : 0;
}

interface RankedModel {
  model: string;
  accuracy: number;
  deterministic: number;
  costPerCase: number;
  avgLatencyMs: number;
  safety: number;
}

export function getRecommendation(report: RunReport): { winner: RankedModel; ranked: RankedModel[]; reason: string } | null {
  const ranked = report.models
    .filter((model) => {
      const usage = report.per_model_usage[model];
      return report.total_cases - usage.api_errors - usage.parse_failures > 0;
    })
    .map((model): RankedModel => {
      const judgeAvg = report.judge_per_model_avg?.[model];
      return {
        model,
        accuracy: judgeAvg?.accuracy ?? deterministicOverall(report, model) * 10,
        deterministic: deterministicOverall(report, model),
        costPerCase: costPerCase(report, model),
        avgLatencyMs: avgLatency(report, model),
        safety: judgeAvg?.safety ?? 0
      };
    });

  if (ranked.length === 0) return null;

  ranked.sort((a, b) => {
    const accuracyDelta = b.accuracy - a.accuracy;
    if (Math.abs(accuracyDelta) > ACCURACY_TIE_BAND) return accuracyDelta;
    const costDelta = a.costPerCase - b.costPerCase;
    if (Math.abs(costDelta) > 0.000001) return costDelta;
    return a.avgLatencyMs - b.avgLatencyMs;
  });

  const winner = ranked[0];
  const topAccuracy = [...ranked].sort((a, b) => b.accuracy - a.accuracy)[0];
  const reason =
    winner.model === topAccuracy.model
      ? `It has the strongest accuracy signal at ${rating(winner.accuracy)}/10, with ${money(winner.costPerCase)} per case and ${winner.avgLatencyMs.toFixed(0)}ms average latency.`
      : `It is within ${ACCURACY_TIE_BAND} accuracy points of the top model, then wins on price at ${money(winner.costPerCase)} per case and ${winner.avgLatencyMs.toFixed(0)}ms average latency.`;

  return { winner, ranked, reason };
}

export function renderMarkdown(report: RunReport): string {
  const lines: string[] = [];
  const recommendation = getRecommendation(report);

  lines.push('# LLM Evaluation Report');
  lines.push('');
  lines.push(`- Started: ${report.started_at}`);
  lines.push(`- Finished: ${report.finished_at}`);
  lines.push(`- Cases: ${report.total_cases}`);
  lines.push(`- Models: ${report.models.map((model) => `\`${model}\``).join(', ')}`);
  if (report.judge) lines.push(`- Judge: \`${report.judge}\``);
  lines.push('');

  if (recommendation) {
    lines.push('## Recommendation');
    lines.push('');
    lines.push(`**Recommended model:** \`${recommendation.winner.model}\``);
    lines.push('');
    lines.push(recommendation.reason);
    lines.push('');
  }

  lines.push('## Executive Summary');
  lines.push('');
  lines.push('| Model | Deterministic | Judge accuracy | Judge overall | Judge wins | Cost | Cost/case | Avg latency | Parse failures | API errors |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');

  for (const model of report.models) {
    const usage = report.per_model_usage[model];
    const judgeAvg = report.judge_per_model_avg?.[model];
    const wins = report.judge_wins?.[model] ?? 0;
    lines.push(
      `| \`${model}\` | ${pct(deterministicOverall(report, model))} | ${judgeAvg ? `${rating(judgeAvg.accuracy)}/10` : '-'} | ${judgeAvg ? `${rating(judgeAvg.overall)}/10` : '-'} | ${wins} | ${money(usage.estimated_cost_usd)} | ${money(costPerCase(report, model))} | ${avgLatency(report, model).toFixed(0)}ms | ${usage.parse_failures} | ${usage.api_errors}${usage.data_policy_blocks > 0 ? ` (${usage.data_policy_blocks} policy)` : ''} |`
    );
  }

  lines.push('');

  const policyBlocked = report.models.filter((model) => (report.per_model_usage[model]?.data_policy_blocks ?? 0) > 0);
  if (policyBlocked.length > 0) {
    lines.push('> **Data-policy blocks:** ' + policyBlocked.map((model) => `\`${model}\``).join(', ') +
      ' had requests rejected by the OpenRouter account data policy (no ZDR-compliant endpoints). Their scores are not meaningful — adjust https://openrouter.ai/settings/privacy and rerun.');
    lines.push('');
  }

  if (recommendation) {
    lines.push('## Priority Ranking');
    lines.push('');
    lines.push('Sorted by accuracy first, then price, then speed. Models within 0.25 accuracy points are treated as tied so price can decide.');
    lines.push('');
    lines.push('| Rank | Model | Accuracy | Deterministic | Cost/case | Avg latency | Safety |');
    lines.push('|---:|---|---:|---:|---:|---:|---:|');
    for (const [index, model] of recommendation.ranked.entries()) {
      lines.push(
        `| ${index + 1} | \`${model.model}\` | ${rating(model.accuracy)}/10 | ${pct(model.deterministic)} | ${money(model.costPerCase)} | ${model.avgLatencyMs.toFixed(0)}ms | ${model.safety ? `${rating(model.safety)}/10` : '-'} |`
      );
    }
    lines.push('');
  }

  lines.push('## Pricing Snapshot');
  lines.push('');
  lines.push('| Model | Input $/1M | Output $/1M | Source |');
  lines.push('|---|---:|---:|---|');
  for (const model of report.models) {
    const pricing = report.pricing[model];
    lines.push(`| \`${model}\` | ${money(pricing.input_per_million_usd)} | ${money(pricing.output_per_million_usd)} | ${pricing.source} |`);
  }
  if (report.judge) {
    const pricing = report.pricing[report.judge];
    if (pricing) lines.push(`| \`${report.judge}\` judge | ${money(pricing.input_per_million_usd)} | ${money(pricing.output_per_million_usd)} | ${pricing.source} |`);
  }
  lines.push('');

  lines.push('## Case Details');
  lines.push('');
  for (const testCase of report.cases) {
    lines.push(`### ${testCase.case_id} (${testCase.category})`);
    lines.push('');

    for (const model of report.models) {
      const output = testCase.outputs.find((item) => item.model === model);
      const score = testCase.deterministic_scores[model];
      if (!output) continue;
      if (output.error) {
        lines.push(`- \`${model}\` - API error: ${output.error}`);
      } else {
        const failed = score.failed_checks.length > 0 ? `; failed: ${score.failed_checks.map((item) => item.reason).join('; ')}` : '';
        lines.push(`- \`${model}\` - ${pct(score.score)} deterministic, ${output.input_tokens}/${output.output_tokens} tokens, ${output.latency_ms}ms${failed}`);
      }
    }

    if (testCase.judge_verdict) {
      lines.push('');
      lines.push(`Judge best: \`${testCase.judge_verdict.best_model || 'none'}\``);
      lines.push('');
      lines.push(testCase.judge_verdict.best_reason || 'No judge reason.');
      lines.push('');
    }
  }

  return `${lines.join('\n')}\n`;
}
