#!/usr/bin/env node

import 'dotenv/config';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chat, ChatError, estimateCost, getModelPricing, loadLivePricing, parseJsonLoose } from './openrouter.js';
import { judgeCase } from './judge.js';
import { getRecommendation, renderMarkdown } from './report.js';
import { scoreCase } from './score.js';
import type { CaseResult, EvalCase, ModelOutput, ModelUsage, RunReport } from './types.js';

interface CliArgs {
  models: string[];
  judge?: string;
  casesDir: string;
  limit?: number;
  caseId?: string;
  category?: string;
  timeoutMs: number;
  judgeTimeoutMs: number;
  sequential: boolean;
  out: string;
  json?: string;
}

function usage(): never {
  console.log(`Usage:
  npm run eval -- --model <id> [--model <id>...] [options]

Options:
  --model <id>                 Candidate model. Repeat for multiple models.
  --judge <id>                 Optional judge model.
  --cases <dir>                Cases directory. Default: examples/cases
  --category <name>            Run one category.
  --case <id>                  Run one case.
  --limit <n>                  Run first n matching cases.
  --timeout-seconds <n>        Candidate timeout. Default: 60.
  --judge-timeout-seconds <n>  Judge timeout. Default: 120.
  --sequential                 Run candidate models one at a time.
  --out <path>                 Markdown report path. Default: reports/report.md
  --json <path>                Optional raw JSON report path.
`);
  process.exit(1);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    models: [],
    casesDir: 'examples/cases',
    timeoutMs: 60_000,
    judgeTimeoutMs: 120_000,
    sequential: false,
    out: 'reports/report.md'
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) usage();
      return value;
    };

    if (arg === '--model') args.models.push(next());
    else if (arg === '--judge') args.judge = next();
    else if (arg === '--cases') args.casesDir = next();
    else if (arg === '--category') args.category = next();
    else if (arg === '--case') args.caseId = next();
    else if (arg === '--limit') args.limit = Number(next());
    else if (arg === '--timeout-seconds') args.timeoutMs = Number(next()) * 1000;
    else if (arg === '--judge-timeout-seconds') args.judgeTimeoutMs = Number(next()) * 1000;
    else if (arg === '--sequential') args.sequential = true;
    else if (arg === '--out') args.out = next();
    else if (arg === '--json') args.json = next();
    else if (arg === '--help' || arg === '-h') usage();
    else usage();
  }

  if (args.models.length === 0) usage();
  return args;
}

async function loadCases(casesDir: string): Promise<EvalCase[]> {
  const files = (await readdir(casesDir)).filter((file) => file.endsWith('.json')).sort();
  const cases: EvalCase[] = [];

  for (const file of files) {
    const raw = await readFile(path.join(casesDir, file), 'utf8');
    const data = JSON.parse(raw) as EvalCase[] | EvalCase;
    cases.push(...(Array.isArray(data) ? data : [data]));
  }

  return cases;
}

function emptyUsage(): ModelUsage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    estimated_cost_usd: 0,
    total_latency_ms: 0,
    parse_failures: 0,
    api_errors: 0
  };
}

async function runModel(model: string, evalCase: EvalCase, timeoutMs: number): Promise<ModelOutput> {
  const jsonMode = evalCase.json_mode ?? evalCase.checks.length > 0;

  try {
    const result = await chat({
      model,
      system: evalCase.system,
      user: evalCase.input,
      jsonMode,
      timeoutMs
    });

    const parsed = jsonMode ? parseJsonLoose(result.content) : { ok: true as const, data: result.content };
    const parseOk = parsed.ok;

    return {
      model,
      raw_text: result.content,
      parsed: parsed.ok ? parsed.data : null,
      parse_ok: parseOk,
      parse_error: parsed.ok ? undefined : parsed.error,
      latency_ms: result.latency_ms,
      input_tokens: result.input_tokens,
      output_tokens: result.output_tokens,
      estimated_cost_usd: estimateCost(model, result.input_tokens, result.output_tokens)
    };
  } catch (error) {
    const latency = error instanceof ChatError ? error.latency_ms : 0;
    return {
      model,
      raw_text: '',
      parsed: null,
      parse_ok: false,
      latency_ms: latency,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_usd: 0,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function applyUsage(usage: ModelUsage, output: ModelOutput): void {
  usage.input_tokens += output.input_tokens;
  usage.output_tokens += output.output_tokens;
  usage.estimated_cost_usd += output.estimated_cost_usd;
  usage.total_latency_ms += output.latency_ms;
  if (output.error) usage.api_errors += 1;
  else if (!output.parse_ok) usage.parse_failures += 1;
}

function aggregateJudge(report: RunReport): void {
  if (!report.judge) return;

  const wins: Record<string, number> = Object.fromEntries(report.models.map((model) => [model, 0]));
  const totals: NonNullable<RunReport['judge_per_model_avg']> = {};

  for (const result of report.cases) {
    const verdict = result.judge_verdict;
    if (!verdict) continue;
    if (verdict.best_model) wins[verdict.best_model] = (wins[verdict.best_model] ?? 0) + 1;

    for (const row of verdict.per_model) {
      const total = (totals[row.model] ??= {
        accuracy: 0,
        format_adherence: 0,
        specificity: 0,
        safety: 0,
        overall: 0,
        cases: 0
      });
      total.accuracy += row.accuracy;
      total.format_adherence += row.format_adherence;
      total.specificity += row.specificity;
      total.safety += row.safety;
      total.overall += row.overall;
      total.cases += 1;
    }
  }

  for (const total of Object.values(totals)) {
    if (total.cases === 0) continue;
    total.accuracy /= total.cases;
    total.format_adherence /= total.cases;
    total.specificity /= total.cases;
    total.safety /= total.cases;
    total.overall /= total.cases;
  }

  report.judge_wins = wins;
  report.judge_per_model_avg = totals;
}

function pricingSnapshot(models: string[]): RunReport['pricing'] {
  const snapshot: RunReport['pricing'] = {};
  for (const model of models) {
    const pricing = getModelPricing(model);
    snapshot[model] = pricing
      ? { input_per_million_usd: pricing.input, output_per_million_usd: pricing.output, source: pricing.source }
      : { input_per_million_usd: 0, output_per_million_usd: 0, source: 'unknown' };
  }
  return snapshot;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const pricing = await loadLivePricing();
  if (pricing.count > 0) console.log(`[pricing] loaded live OpenRouter prices for ${pricing.count} models`);
  else if (pricing.error) console.log(`[pricing] live pricing unavailable: ${pricing.error}`);

  let cases = await loadCases(args.casesDir);
  if (args.category) cases = cases.filter((item) => item.category === args.category);
  if (args.caseId) cases = cases.filter((item) => item.id === args.caseId);
  if (args.limit != null) cases = cases.slice(0, args.limit);

  const candidateCalls = cases.length * args.models.length;
  const judgeCalls = args.judge ? cases.length : 0;
  console.log(`Running ${cases.length} cases x ${args.models.length} models${args.judge ? ` with judge ${args.judge}` : ''}`);
  console.log(`Planned API calls: ${candidateCalls} candidates + ${judgeCalls} judge = ${candidateCalls + judgeCalls}`);

  const startedAt = new Date().toISOString();
  const usage: Record<string, ModelUsage> = Object.fromEntries(args.models.map((model) => [model, emptyUsage()]));
  if (args.judge) usage[args.judge] = emptyUsage();
  const results: CaseResult[] = [];

  for (const [index, evalCase] of cases.entries()) {
    console.log(`\n[${index + 1}/${cases.length}] ${evalCase.id} (${evalCase.category})`);

    const outputs = args.sequential
      ? []
      : await Promise.all(args.models.map((model) => runModel(model, evalCase, args.timeoutMs)));

    if (args.sequential) {
      for (const model of args.models) outputs.push(await runModel(model, evalCase, args.timeoutMs));
    }

    for (const output of outputs) {
      applyUsage(usage[output.model], output);
      const status = output.error ? `ERROR ${output.error.slice(0, 120)}` : `${output.input_tokens}/${output.output_tokens} tok ${output.latency_ms}ms`;
      console.log(`  ${output.model.padEnd(42)} ${status}`);
    }

    const deterministic_scores: CaseResult['deterministic_scores'] = {};
    for (const output of outputs) {
      deterministic_scores[output.model] = output.parse_ok ? scoreCase(output.parsed, evalCase.checks) : scoreCase(null, evalCase.checks);
    }

    const caseResult: CaseResult = {
      case_id: evalCase.id,
      category: evalCase.category,
      outputs,
      deterministic_scores
    };

    if (args.judge) {
      process.stdout.write('  judging... ');
      const verdict = await judgeCase(args.judge, evalCase, outputs, args.judgeTimeoutMs);
      caseResult.judge_verdict = verdict;
      usage[args.judge].input_tokens += verdict.input_tokens;
      usage[args.judge].output_tokens += verdict.output_tokens;
      usage[args.judge].estimated_cost_usd += verdict.estimated_cost_usd;
      usage[args.judge].total_latency_ms += verdict.latency_ms;
      console.log(verdict.best_model || 'judge failed');
    }

    results.push(caseResult);
  }

  const report: RunReport = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    total_cases: cases.length,
    models: args.models,
    judge: args.judge,
    cases: results,
    per_model_usage: usage,
    pricing: pricingSnapshot(args.judge ? [...args.models, args.judge] : args.models)
  };

  aggregateJudge(report);

  const recommendation = getRecommendation(report);
  if (recommendation) {
    console.log(`\nRecommended model: ${recommendation.winner.model}`);
    console.log(`Why: ${recommendation.reason}`);
  }

  const markdown = renderMarkdown(report);
  await mkdir(path.dirname(args.out), { recursive: true });
  await writeFile(args.out, markdown, 'utf8');
  console.log(`\nMarkdown report: ${args.out}`);

  if (args.json) {
    await mkdir(path.dirname(args.json), { recursive: true });
    await writeFile(args.json, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`JSON report: ${args.json}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
