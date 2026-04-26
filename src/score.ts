import type { Check, DeterministicScore } from './types.js';

function weight(check: Check): number {
  return check.weight ?? 1;
}

function resolvePath(value: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, part) => {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    if (typeof current === 'object') return (current as Record<string, unknown>)[part];
    return undefined;
  }, value);
}

function normalize(value: unknown): string {
  if (typeof value === 'string') return value.toLowerCase();
  return JSON.stringify(value ?? '').toLowerCase();
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function evaluate(check: Check, parsed: unknown): { passed: boolean; reason: string } {
  const value = resolvePath(parsed, check.path);

  switch (check.kind) {
    case 'json_path_equals':
      return Object.is(value, check.value)
        ? { passed: true, reason: 'matched expected value' }
        : { passed: false, reason: `${check.path} expected ${JSON.stringify(check.value)}, got ${JSON.stringify(value)}` };

    case 'json_path_in':
      return check.any_of.some((item) => Object.is(value, item))
        ? { passed: true, reason: 'matched allowed value' }
        : { passed: false, reason: `${check.path} expected one of ${JSON.stringify(check.any_of)}, got ${JSON.stringify(value)}` };

    case 'string_contains_any': {
      const haystack = normalize(value);
      const matched = check.contains_any.some((needle) => haystack.includes(needle.toLowerCase()));
      return matched
        ? { passed: true, reason: 'contained one required string' }
        : { passed: false, reason: `${check.path} did not contain any of ${check.contains_any.join(', ')}` };
    }

    case 'string_contains_all': {
      const haystack = normalize(value);
      const missing = check.contains_all.filter((needle) => !haystack.includes(needle.toLowerCase()));
      return missing.length === 0
        ? { passed: true, reason: 'contained all required strings' }
        : { passed: false, reason: `${check.path} missed ${missing.join(', ')}` };
    }

    case 'string_excludes': {
      const haystack = normalize(value);
      const found = check.excludes.filter((needle) => haystack.includes(needle.toLowerCase()));
      return found.length === 0
        ? { passed: true, reason: 'excluded forbidden strings' }
        : { passed: false, reason: `${check.path} contained forbidden strings: ${found.join(', ')}` };
    }

    case 'array_min_length': {
      const length = asArray(value).length;
      return length >= check.min
        ? { passed: true, reason: 'array length is high enough' }
        : { passed: false, reason: `${check.path} length expected >= ${check.min}, got ${length}` };
    }

    case 'array_max_length': {
      const length = asArray(value).length;
      return length <= check.max
        ? { passed: true, reason: 'array length is low enough' }
        : { passed: false, reason: `${check.path} length expected <= ${check.max}, got ${length}` };
    }

    case 'max_chars': {
      const length = typeof value === 'string' ? value.length : normalize(value).length;
      return length <= check.limit
        ? { passed: true, reason: 'within character limit' }
        : { passed: false, reason: `${check.path} expected <= ${check.limit} chars, got ${length}` };
    }

    case 'json_path_truthy':
      return value ? { passed: true, reason: 'truthy' } : { passed: false, reason: `${check.path} was not truthy` };
  }
}

export function scoreCase(parsed: unknown, checks: Check[]): DeterministicScore {
  let passedWeight = 0;
  let totalWeight = 0;
  const failed_checks: DeterministicScore['failed_checks'] = [];
  const passed_checks: Check[] = [];

  for (const check of checks) {
    const checkWeight = weight(check);
    totalWeight += checkWeight;
    const result = evaluate(check, parsed);
    if (result.passed) {
      passedWeight += checkWeight;
      passed_checks.push(check);
    } else {
      failed_checks.push({ check, reason: result.reason });
    }
  }

  return {
    passed_weight: passedWeight,
    total_weight: totalWeight,
    score: totalWeight > 0 ? passedWeight / totalWeight : 0,
    failed_checks,
    passed_checks
  };
}

