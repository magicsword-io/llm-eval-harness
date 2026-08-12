export type Check =
  | {
      kind: 'json_path_equals';
      path: string;
      value: unknown;
      weight?: number;
      note?: string;
    }
  | {
      kind: 'json_path_in';
      path: string;
      any_of: unknown[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'string_contains_any';
      path: string;
      contains_any: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'string_contains_all';
      path: string;
      contains_all: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'string_excludes';
      path: string;
      excludes: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'array_min_length';
      path: string;
      min?: number;
      limit?: number;
      weight?: number;
      note?: string;
    }
  | {
      kind: 'array_max_length';
      path: string;
      max?: number;
      limit?: number;
      weight?: number;
      note?: string;
    }
  | {
      kind: 'max_chars';
      path: string;
      limit: number;
      weight?: number;
      note?: string;
    }
  | {
      kind: 'json_path_truthy';
      path: string;
      weight?: number;
      note?: string;
    }
  | {
      kind: 'number_in_range';
      path: string;
      min?: number;
      max?: number;
      weight?: number;
      note?: string;
    }
  | {
      kind: 'mitre_includes_any';
      path: string;
      any_of: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'mitre_includes_all';
      path: string;
      all_of: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'mitre_excludes';
      path: string;
      excludes: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'evidence_signal_any';
      path: string;
      contains_any: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'no_invented_entries';
      path: string;
      allowed_entries: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'rule_value_matches';
      action?: 'allow' | 'deny';
      contains_any: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'rule_value_excludes';
      action?: 'allow' | 'deny';
      excludes: string[];
      weight?: number;
      note?: string;
    }
  | {
      kind: 'rule_action_count';
      action?: 'allow' | 'deny';
      min?: number;
      max?: number;
      weight?: number;
      note?: string;
    };

export interface EvalCase {
  id: string;
  category: string;
  description: string;
  /** Inline system prompt. Either this or system_prompt_key is required. */
  system?: string;
  /** Key into prompts.json in the cases directory. Resolved at load time. */
  system_prompt_key?: string;
  input: string;
  json_mode?: boolean;
  checks: Check[];
  gold_notes?: string;
  judge_rubric?: string;
}

export interface ModelOutput {
  model: string;
  raw_text: string;
  parsed: unknown;
  parse_ok: boolean;
  parse_error?: string;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  error?: string;
  error_kind?: 'data_policy' | 'timeout' | 'api';
}

export interface DeterministicScore {
  passed_weight: number;
  total_weight: number;
  score: number;
  failed_checks: Array<{ check: Check; reason: string }>;
  passed_checks: Check[];
}

export interface JudgeModelScore {
  model: string;
  accuracy: number;
  format_adherence: number;
  specificity: number;
  safety: number;
  overall: number;
  hallucinations: string[];
  strengths: string[];
  weaknesses: string[];
}

export interface JudgeVerdict {
  case_id: string;
  per_model: JudgeModelScore[];
  best_model: string;
  best_reason: string;
  patterns: string[];
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
  estimated_cost_usd: number;
}

export interface CaseResult {
  case_id: string;
  category: string;
  outputs: ModelOutput[];
  deterministic_scores: Record<string, DeterministicScore>;
  judge_verdict?: JudgeVerdict;
}

export interface ModelUsage {
  input_tokens: number;
  output_tokens: number;
  estimated_cost_usd: number;
  total_latency_ms: number;
  parse_failures: number;
  api_errors: number;
  data_policy_blocks: number;
}

export interface RunReport {
  started_at: string;
  finished_at: string;
  total_cases: number;
  models: string[];
  judge?: string;
  cases: CaseResult[];
  per_model_usage: Record<string, ModelUsage>;
  judge_wins?: Record<string, number>;
  judge_per_model_avg?: Record<
    string,
    {
      accuracy: number;
      format_adherence: number;
      specificity: number;
      safety: number;
      overall: number;
      cases: number;
    }
  >;
  pricing: Record<string, { input_per_million_usd: number; output_per_million_usd: number; source: 'live' | 'fallback' | 'unknown' }>;
}

