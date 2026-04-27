# Writing Test Cases

Test cases are JSON files that describe what to send to each model and how to score the response.

You can add files under `examples/cases/` or keep your own cases elsewhere and pass them with `--cases`.

```bash
npm run eval -- \
  --cases ./my-cases \
  --model google/gemini-3.1-flash-lite-preview \
  --model x-ai/grok-4.1-fast \
  --out reports/my-run.md \
  --json reports/my-run.json
```

Each `.json` file can contain either one case object or an array of case objects.

## Minimal Case

```json
{
  "id": "support-001-refund-request",
  "category": "support-triage",
  "description": "Refund request should route to billing review.",
  "system": "Return only JSON with this shape: {\"decision\":\"approve|review|deny\",\"reason\":\"string\"}.",
  "input": "Customer says they were billed twice and asks for a refund.",
  "checks": [
    {
      "kind": "json_path_equals",
      "path": "decision",
      "value": "review",
      "weight": 3
    },
    {
      "kind": "string_contains_any",
      "path": "reason",
      "contains_any": ["refund", "billing", "duplicate"],
      "weight": 1
    }
  ]
}
```

When `checks` are present, the runner enables OpenRouter JSON mode by default. Include the word `JSON` in your system prompt because some providers require it when JSON mode is requested.

## Case Fields

| Field | Required | Purpose |
|---|---:|---|
| `id` | Yes | Stable unique ID for the case. Use something easy to grep, such as `support-001-refund-request`. |
| `category` | Yes | Workflow group, such as `support-triage`, `policy-review`, or `incident-summary`. |
| `description` | Yes | Short human-readable description of what this case tests. |
| `system` | Yes | System prompt sent to every candidate model. |
| `input` | Yes | User message or task input sent to every candidate model. |
| `checks` | Yes | Array of deterministic checks. Use `[]` for judge-only cases. |
| `json_mode` | No | Overrides automatic JSON mode. Defaults to `true` when checks exist, otherwise `false`. |
| `gold_notes` | No | Notes explaining the expected strong answer. Passed to the judge when `--judge` is used. |
| `judge_rubric` | No | Case-specific guidance for the judge. |

## How Checks Work

Checks read values out of the model's parsed JSON using dot paths.

For this model output:

```json
{
  "decision": "review",
  "severity": "medium",
  "summary": "Duplicate billing refund request needs billing review.",
  "evidence": ["duplicate billing", "refund request"],
  "actions": ["Open billing ticket"]
}
```

These paths are valid:

```text
decision
severity
summary
evidence
actions.0
```

Each check has an optional `weight`. Higher weights make important requirements count more. If no weight is set, the check is worth `1`.

## Supported Checks

### `json_path_equals`

Passes when a JSON path exactly equals a value.

```json
{
  "kind": "json_path_equals",
  "path": "decision",
  "value": "review",
  "weight": 3
}
```

Use this for required enum decisions, booleans, or exact strings.

### `json_path_in`

Passes when a JSON path equals one value from an allowed list.

```json
{
  "kind": "json_path_in",
  "path": "severity",
  "any_of": ["medium", "high"],
  "weight": 2
}
```

Use this when several answers are acceptable.

### `string_contains_any`

Passes when the value contains at least one required string. The value can be a string, array, or object.

```json
{
  "kind": "string_contains_any",
  "path": "evidence",
  "contains_any": ["refund", "billing", "duplicate"]
}
```

Use this for evidence coverage.

### `string_contains_all`

Passes when the value contains every required string.

```json
{
  "kind": "string_contains_all",
  "path": "summary",
  "contains_all": ["duplicate", "billing"]
}
```

Use this when missing any term should fail the check.

### `string_excludes`

Passes when the value does not contain forbidden strings.

```json
{
  "kind": "string_excludes",
  "path": "summary",
  "excludes": ["guaranteed fraud", "legal violation"]
}
```

Use this to catch hallucinated claims, unsafe language, or prohibited recommendations.

### `array_min_length`

Passes when an array has at least `min` items.

```json
{
  "kind": "array_min_length",
  "path": "actions",
  "min": 1
}
```

Use this when a response must include at least one evidence item or action.

### `array_max_length`

Passes when an array has no more than `max` items.

```json
{
  "kind": "array_max_length",
  "path": "actions",
  "max": 3
}
```

Use this to enforce concise outputs.

### `max_chars`

Passes when a string is under a character limit.

```json
{
  "kind": "max_chars",
  "path": "summary",
  "limit": 180
}
```

Use this for UI-bound summaries.

### `json_path_truthy`

Passes when a path exists and is truthy.

```json
{
  "kind": "json_path_truthy",
  "path": "reason"
}
```

Use this for required fields where exact content is not important.

## Judge-Only Cases

Use an empty `checks` array when deterministic scoring is not useful.

```json
{
  "id": "summary-001-quality-check",
  "category": "summary",
  "description": "Compare summary quality.",
  "system": "Write a concise customer-facing summary.",
  "input": "Long source text here...",
  "checks": [],
  "gold_notes": "A strong answer is concise, accurate, and avoids invented details.",
  "judge_rubric": "Reward factuality and clarity. Penalize invented details."
}
```

Then run with a judge:

```bash
npm run eval -- \
  --model google/gemini-3.1-flash-lite-preview \
  --model x-ai/grok-4.1-fast \
  --judge openai/gpt-5.4-mini
```

## Good Case Design

Write cases that expose real differences between models.

Good cases usually include:

- A clear expected decision.
- At least one edge case or trap.
- Required evidence that a model should cite.
- A forbidden behavior to avoid.
- A short `gold_notes` explanation for future readers.

Avoid cases that are too easy. If every model gets 100%, the case is not helping you choose.

## Reports

The `reports/` folder is where generated outputs go.

- Markdown reports are for humans.
- JSON reports are for reranking, debugging, or offline review.
- Generated report files are ignored by git so you do not accidentally commit private prompts, model outputs, costs, or test data.

