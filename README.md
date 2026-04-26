# MagicSword LLM Eval

An open-source starting point for testing LLMs against real product workflows before putting them in production.

This project is based on the evaluation pattern MagicSword uses for security-agent model selection: run the same cases across multiple models, score objective requirements with deterministic checks, optionally use an LLM judge for comparative review, and rank models by production priorities.

## Why This Exists

Most model comparisons stop at vibe checks: paste a prompt into a few chats, read the answers, and pick the one that feels best.

That is not enough for production security workflows. A model can sound confident while inventing facts, violating output schemas, choosing unsafe actions, or returning a response that cannot be parsed by the app.

This eval pattern is built around four questions:

1. Did the model follow the required output format?
2. Did it make the right decision for the case?
3. Did it avoid hallucinated facts, rule syntax, techniques, or evidence?
4. Is the model cheap and fast enough to run in production?

## Scoring Model

The recommended evaluation has two layers.

### 1. Deterministic Checks

Use code to score anything that can be made objective:

- Required JSON fields are present.
- Decision enums match the expected outcome.
- Required evidence appears in the response.
- Forbidden claims or overly broad rules are absent.
- Output length limits are respected.
- Known factuality traps are not invented.

These checks are fast, cheap, repeatable, and do not require another model.

### 2. LLM-as-Judge

For cases where nuance matters, run a judge model over every candidate response for the same test case.

The judge should grade each candidate on:

- Accuracy
- Format adherence
- Specificity
- Safety
- Overall quality

The judge should also name the best response and call out hallucinations or risky behavior.

Treat the judge as a reviewer, not an oracle. For important model switches, run more than one judge and compare the reports.

## Ranking Priorities

MagicSword ranks production model candidates in this order:

1. Accuracy
2. Pricing
3. Speed

In practice, that means the model with the highest accuracy usually wins, unless another model is effectively tied on accuracy and materially cheaper or faster.

The report should include:

- Deterministic score by model
- Judge score by rubric
- Judge win count
- Token usage
- Estimated cost
- Average latency
- API errors
- Parse failures
- Recommended model and reason

## Example Model Set

The exact best model changes over time, so always rerun the eval before changing production. A recent challenger set looked like:

```text
google/gemini-3.1-flash-lite-preview
google/gemini-3-flash-preview
x-ai/grok-4.1-fast
google/gemini-3.1-pro-preview
openai/gpt-5.4-mini
openai/gpt-5.4-nano
```

The useful result was not just the winner. The report also showed which models were good fallbacks, which were too expensive for the quality gain, and which had provider or structured-output reliability problems.

## What To Open Source

Recommended public contents:

- The runner architecture
- The report format
- Sanitized example cases
- Deterministic scoring examples
- Judge prompt templates
- Cost and latency reporting

Keep private:

- Customer data
- Internal production prompts that expose proprietary logic
- Private threat intelligence feeds
- Raw production outputs
- API keys and Vercel environment values

## Suggested Repo Layout

```text
.
├── README.md
├── docs/
│   └── blog-draft.md
├── examples/
│   ├── cases/
│   └── reports/
└── src/
    ├── run.ts
    ├── score.ts
    ├── judge.ts
    └── report.ts
```

## Status

This repo currently contains the public-facing project README and blog draft. The next step is to copy over a sanitized version of the evaluator code and example cases.

