# How We Test LLMs Before Letting Them Into Production Workflows

Picking an LLM for a production feature is not the same as picking a model for a demo.

In a demo, the answer can be impressive if it sounds right. In production, sounding right is not enough. The model has to follow the output contract, make the right decision, avoid inventing evidence, stay within cost limits, and return quickly enough that users are not waiting on it.

We recently built a repeatable model evaluation workflow for a security-focused product. The goal was simple: stop choosing models by vibe and start choosing them with evidence.

## The Problem With Ad Hoc Model Testing

The common workflow for testing models looks like this:

1. Paste a production prompt into a few models.
2. Read the answers.
3. Pick the one that feels strongest.

That can be useful for a first impression, but it breaks down quickly.

Production workflows have edge cases. A model may correctly handle an obvious case but fail when the evidence is ambiguous. Another model may produce a polished answer but invent facts. Another may choose the right action but return malformed JSON that the app cannot parse.

We needed a harness that could answer practical questions:

- Does the model follow our schema every time?
- Does it choose the right action on hard cases?
- Does it hallucinate facts, techniques, or evidence?
- How much does it cost per case?
- How fast is it?
- What happens when the provider fails?

## The Eval Structure

The eval suite runs the same test cases across multiple candidate models through OpenRouter. Each test case represents a workflow we care about, such as classification, policy review, incident summarization, support triage, or enrichment.

Each candidate model receives the same system prompt and user input. The runner records:

- Raw response
- Parsed JSON
- Token usage
- Estimated cost
- Latency
- API errors
- Parse failures

From there, each output is scored in two ways.

## Layer 1: Deterministic Checks

The first scoring layer is pure code.

For every case where we expect structured output, we define checks that can be evaluated deterministically:

- The decision must equal an expected enum.
- Required evidence must be present.
- Certain fields must stay under length limits.
- The model must not name facts that were not in the prompt.
- Risk levels must match the case.
- Broad or unsafe recommendations must not be approved.

This layer is cheap and repeatable. It catches failures that do not require judgment.

If a prompt gives the model five facts and the model invents a sixth, no judge is needed. That is a deterministic failure.

## Layer 2: LLM-as-Judge

Some failures are harder to capture with code. Analysis has nuance: context matters, evidence quality matters, and two answers can both be parseable while one is much safer.

For those cases, we use a judge model.

The judge sees:

- The original system prompt
- The user message
- Gold notes for the case
- The rubric
- Every candidate model response

It then grades each model on:

- Accuracy
- Format adherence
- Specificity
- Safety
- Overall quality

The judge also picks the best response for that case and lists hallucinations or cross-model patterns.

We do not treat the judge as perfect. It is another model with its own bias. But it is useful when paired with deterministic checks and human review.

## Accuracy First, Then Cost, Then Speed

Our ranking priority is:

1. Accuracy
2. Pricing
3. Speed

That order matters.

For a workflow that users rely on, a cheap model that makes unsafe decisions is not cheap. It creates downstream review cost, false positives, false negatives, and trust problems.

But once two models are close enough on accuracy, cost matters a lot. A model that is slightly better but 20x more expensive is not automatically the right default. It may be better as a fallback for hard cases rather than the primary model.

Speed comes third. Fast is valuable, especially for inline workflows, but not at the expense of correctness.

## What The Report Shows

Each run writes a report with:

- Executive summary
- Recommended model
- Deterministic score by model
- Judge score by rubric
- Judge win count
- Cost per case
- Average latency
- Parse failures
- API errors
- Per-case verdicts

This changes the model-selection conversation. Instead of asking “which answer do we like?”, we can ask:

- Which model is most accurate on the cases that matter?
- Which one is the best production default?
- Which one should be the fallback?
- Which failures are provider reliability problems versus model-quality problems?
- Is the expensive model actually buying enough quality?

## A Practical Lesson: Judge Cost Can Dominate

One surprise was that the judge can cost more than the candidates.

A judged eval sends every candidate response back into the judge. If you test many models with long outputs and use a premium judge, the judge bill can dominate the run.

Our practical approach:

- Use deterministic checks during iteration.
- Use small smoke runs when testing a new judge.
- Run the full judged suite only against finalists.
- Compare at least two judges before making a high-stakes switch.
- Save the raw JSON report so another reviewer can inspect the result without rerunning the candidates.

That last point matters. If you already pay for a separate coding assistant or analysis tool, you can generate the raw report once and have that tool review the report offline instead of paying an expensive judge for every iteration.

## Why Open Source The Harness

The exact prompts and cases for any production system are specific to that product. But the pattern is broadly useful:

- Test real workflows, not generic benchmarks.
- Use deterministic checks wherever possible.
- Use an LLM judge only where judgment is needed.
- Track cost and latency as first-class metrics.
- Treat provider failures and parse failures as model-selection data.
- Make the recommendation explainable.

The public harness includes:

- A CLI runner
- Example test cases
- Deterministic scoring helpers
- Judge prompt templates
- Markdown and JSON report generation
- Cost and latency rollups
- A recommendation heuristic based on accuracy, price, and speed

It should not include customer data, proprietary prompts, private intelligence, raw internal reports, or secrets.

## Final Thought

The biggest win was not finding one model.

The biggest win was building a process that lets us change models with confidence. Models move fast. Prices change. Providers have outages. New releases appear every week.

The right answer is not a one-time benchmark. It is a repeatable eval that matches the way your product actually uses AI.

