import type { Check, DeterministicScore } from './types.js';

function weight(check: Check): number {
  return check.weight ?? 1;
}

function resolvePath(value: unknown, path: string): unknown {
  const segments = path.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  return segments.reduce<unknown>((current, part) => {
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
  const path = 'path' in check ? check.path : undefined;
  const value = path ? resolvePath(parsed, path) : undefined;

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
      const min = check.min ?? check.limit ?? 0;
      const length = asArray(value).length;
      return length >= min
        ? { passed: true, reason: 'array length is high enough' }
        : { passed: false, reason: `${check.path} length expected >= ${min}, got ${length}` };
    }

    case 'array_max_length': {
      const max = check.max ?? check.limit ?? Infinity;
      const length = asArray(value).length;
      return length <= max
        ? { passed: true, reason: 'array length is low enough' }
        : { passed: false, reason: `${check.path} length expected <= ${max}, got ${length}` };
    }

    case 'max_chars': {
      const length = typeof value === 'string' ? value.length : normalize(value).length;
      return length <= check.limit
        ? { passed: true, reason: 'within character limit' }
        : { passed: false, reason: `${check.path} expected <= ${check.limit} chars, got ${length}` };
    }

    case 'json_path_truthy':
      return value ? { passed: true, reason: 'truthy' } : { passed: false, reason: `${check.path} was not truthy` };

    case 'number_in_range': {
      if (typeof value !== 'number')
        return { passed: false, reason: `${check.path} not a number (got ${JSON.stringify(value)})` };
      const min = check.min ?? -Infinity;
      const max = check.max ?? Infinity;
      return value >= min && value <= max
        ? { passed: true, reason: 'within range' }
        : { passed: false, reason: `${check.path}=${value} not in [${min}, ${max}]` };
    }

    case 'mitre_includes_any': {
      const arr = asArray(value).map((s) => String(s).toUpperCase());
      const wanted = check.any_of.map((w) => w.toUpperCase());
      return wanted.some((w) => arr.includes(w))
        ? { passed: true, reason: 'included a wanted technique' }
        : { passed: false, reason: `${check.path}=${JSON.stringify(arr)} contains none of ${JSON.stringify(wanted)}` };
    }

    case 'mitre_includes_all': {
      const arr = asArray(value).map((s) => String(s).toUpperCase());
      const wanted = check.all_of.map((w) => w.toUpperCase());
      return wanted.every((w) => arr.includes(w))
        ? { passed: true, reason: 'included all wanted techniques' }
        : { passed: false, reason: `${check.path} missing some of ${JSON.stringify(wanted)}` };
    }

    case 'mitre_excludes': {
      const arr = asArray(value).map((s) => String(s).toUpperCase());
      const hit = check.excludes.map((b) => b.toUpperCase()).find((b) => arr.includes(b));
      return hit
        ? { passed: false, reason: `${check.path} contains banned ${hit}` }
        : { passed: true, reason: 'no banned techniques' };
    }

    case 'evidence_signal_any': {
      const arr = asArray(value) as Array<{ signal?: string }>;
      const blob = normalize(arr.map((e) => e?.signal ?? '').join(' | '));
      return check.contains_any.some((needle) => blob.includes(needle.toLowerCase()))
        ? { passed: true, reason: 'evidence signals matched' }
        : { passed: false, reason: `evidence signals lack any of ${JSON.stringify(check.contains_any)}` };
    }

    case 'no_invented_entries': {
      const allowedSet = new Set(check.allowed_entries.map((e) => e.toLowerCase()));
      if (Array.isArray(value)) {
        const bad = value.find((item) => !allowedSet.has(String(item).toLowerCase()));
        return bad == null
          ? { passed: true, reason: 'no invented entries' }
          : { passed: false, reason: `${check.path} contains invented "${String(bad)}"` };
      }
      const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
      const tokens: string[] = [];
      for (const m of text.matchAll(/([A-Za-z0-9_\-.]+\.(exe|dll|sys))/g)) tokens.push(m[1]);
      for (const m of text.matchAll(/\b([0-9a-fA-F]{64})\b/g)) tokens.push(m[1]);
      const invented = tokens.find((t) => !allowedSet.has(t.toLowerCase()));
      return invented == null
        ? { passed: true, reason: 'no invented entries' }
        : { passed: false, reason: `${check.path} mentions invented "${invented}"` };
    }

    case 'rule_value_matches': {
      const rules = rulesByAction(parsed, check.action ?? 'allow');
      const ok = rules.some(
        (r) =>
          check.contains_any.some((n) => normalize(r.value).includes(n.toLowerCase())) ||
          check.contains_any.some((n) => normalize(r.name).includes(n.toLowerCase()))
      );
      return ok
        ? { passed: true, reason: 'found matching rule' }
        : { passed: false, reason: `no ${check.action ?? 'allow'} rule matching ${JSON.stringify(check.contains_any)}` };
    }

    case 'rule_value_excludes': {
      const rules = rulesByAction(parsed, check.action ?? 'allow');
      let bad: string | null = null;
      for (const r of rules) {
        const v = String(r.value ?? '');
        const hit = check.excludes.find((b) => v.toLowerCase().includes(b.toLowerCase()));
        if (hit) {
          bad = `${v} matches banned "${hit}"`;
          break;
        }
      }
      return bad == null
        ? { passed: true, reason: 'no overly broad rules' }
        : { passed: false, reason: `${check.action ?? 'allow'} rule too broad: ${bad}` };
    }

    case 'rule_action_count': {
      const rules = rulesByAction(parsed, check.action ?? 'allow');
      const min = check.min ?? 0;
      const max = check.max ?? Infinity;
      return rules.length >= min && rules.length <= max
        ? { passed: true, reason: 'rule count within range' }
        : { passed: false, reason: `${check.action ?? 'allow'} rule count=${rules.length} not in [${min}, ${max}]` };
    }

    default:
      return { passed: false, reason: `unknown check kind: ${JSON.stringify((check as Check).kind)}` };
  }
}

function rulesByAction(model: unknown, action: 'allow' | 'deny'): Array<Record<string, unknown>> {
  const rules = (model as Record<string, unknown> | null)?.rules;
  if (!Array.isArray(rules)) return [];
  return rules.filter((r) => (r as Record<string, unknown> | null)?.action === action) as Array<Record<string, unknown>>;
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

