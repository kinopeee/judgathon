# Review Guidelines

## Language

- Write all review comments, summaries, and analysis in **Japanese** (日本語).

## Context

This repository implements `hackathon-ai-judge-spec.md` — the spec document
(§41 implementation contract) is the source of truth. When reviewing
behavioral changes, check them against the spec, not just the diff.

## Critical Areas

- **Reproducibility / frozen inputs** — `src/core/input-hash.ts`, `src/cli/repeat.ts`.
  Runs are frozen with `frozen_inputs.hash_version: 2`; the composite
  `input_hash` covers transcript, evidence-set, config/rubric snapshots,
  ordered selected frames, prompt hashes, and the judge schema hash. Any
  change to hashing or serialization invalidates prior runs and must be
  treated as a breaking change (call it out explicitly).
- **Artifact format** — `src/core/storage.ts`, `src/core/schemas/artifacts.ts`.
  All persisted JSON must be snake_case, carry `schema_version`, and be
  written atomically via `writeJsonAtomic` / `writeTextAtomic` (tmp + rename).
  Flag direct `fs.writeFile` of artifact JSON.
- **Exit codes** — `src/core/errors.ts`. CLI failures must go through
  `CliError` with the documented exit codes (0/2/3/4/5). Flag ad-hoc
  `process.exit` calls or new exit codes not documented in README.
- **Secrets and provider boundaries** — `src/providers/`.
  `GOOGLE_API_KEY` must never be written to disk or logs. Fixture mode
  (`src/providers/fixture/`) must perform no network access and no
  credential lookup. Live mode (`src/providers/google/`) keeps SDK retries
  disabled and relies on `isRetryableProviderError` + the 120 s timeout —
  flag changes that weaken these guarantees.

## Conventions

- Strict TypeScript: `strict`, `noUncheckedIndexedAccess`,
  `exactOptionalPropertyTypes`. Do not introduce `any`; validate external
  input with the existing Zod schemas (`src/core/schemas/`).
- Usage accounting: `src/core/usage.ts` uses
  `calculation_version: gemini-output-plus-thinking-v2` — estimated cost is
  `null` when any required token count is unknown, never estimated partially.
- `asr_confidence` is intentionally persisted as `null` in the v2 pipeline —
  do not flag this as a bug.
- `prompts/`, `rubrics/`, `configs/` are versioned content whose hashes feed
  `input_hash`. Edits to prompt text are semantic changes (they change what
  is judged comparable), not typo fixes — flag silent prompt diffs.
- Provider-facing outputs flow through `ProviderCallResult<T>`; keep the
  raw text, usage, and latency fields populated as today.

## Ignore

- `pnpm-lock.yaml` and other lock files can be skipped unless dependencies changed.
- `fixtures/` are canned provider responses for pipeline testing — they do
  not need AI-quality scrutiny, only placeholder/ID-mapping correctness
  (`tr#0`, `frame#2`, `ev#1`).
- `scripts/make-sample-video.mjs` is a dev tool for generating synthetic
  test media — production-hardening suggestions are out of scope.

## Out-of-scope findings

- If a finding concerns something outside the PR's scope, say so in the
  comment and resolve the conversation instead of requesting changes.

## Performance / Robustness

- Flag work that would break the atomic-write contract or leave partial
  artifacts under `--out` on failure.
- The `repeat` judge σ ≤ 0.5 pass threshold and `needs_review` /
  `injection_suspected` flag semantics come from the spec — flag changes
  that alter them without a spec update.
