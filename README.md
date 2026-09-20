# judgathon (Phase 0 PoC)

Batch AI-judging pipeline for hackathon pitch recordings, per
`hackathon-ai-judge-spec.md` v0.4 (§41 implementation contract).

Pipeline: `validate_input → prepare_output → media → transcript → evidence →
judge (3 samples) → scorecard → finalize`, all artifacts under `--out`.

## Setup

```bash
pnpm install --frozen-lockfile   # Node 22, pnpm 10
pnpm build
```

Requires `ffmpeg` and `ffprobe` on PATH.
The `judgathon` launcher requires the build output; without it, it prints
`BUILD_REQUIRED: dist/cli/index.js not found. Run \`pnpm build\` first.` and exits
with code 2.

## Commands

```bash
node scripts/make-sample-video.mjs samples/team_alpha.mp4   # synthetic 60 s sample

pnpm exec judgathon run \
  --video ./samples/team_alpha.mp4 \
  --rubric ./rubrics/hackathon-2026-v3.yaml \
  --config ./configs/judge-google-v2.yaml \
  --output-language ja \
  --provider-mode fixture \
  --out ./out/team_alpha

pnpm exec judgathon repeat \
  --from ./out/team_alpha \
  --times 5 \
  --provider-mode fixture \
  --out ./out/team_alpha_repeat
```

`run` flags: `--video-source screen|camera` (default screen), `--fixture-dir`
(fixture mode only, default `fixtures/default`), `--prompts-dir`
(default `prompts`), `--pricing` (default `configs/pricing.json`),
`--provider-mode fixture|live` (default `fixture`).

`repeat` re-runs only the judge stage (3 samples) five times against the frozen
transcript / evidence-set / selected frames of a completed run, then writes
`repeat-report.json` (per-criterion mean and population σ, pass when σ ≤ 0.5).
Runs are frozen with `frozen_inputs.hash_version: 2`; older runs are rejected
with `UNSUPPORTED_FROZEN_INPUT_VERSION` and must be run again with the current
CLI. The v2 frozen input includes transcript, evidence-set, config and rubric
snapshot hashes, ordered selected-frame records, all prompt hashes, the judge
schema hash, normalized extra review flags, and the composite `input_hash`.

`usage.json` includes `calculation_version:
gemini-output-plus-thinking-v2`. Estimated cost is
`input_tokens * input_rate / 1e6 + (output_tokens + thinking_tokens) *
output_rate / 1e6`; if any required token count is unknown, the estimated cost
is `null`. Transcript `asr_confidence` is always persisted as `null` in the
v2 pipeline because this pipeline has no measured ASR confidence.

## Fixture vs live

`--provider-mode fixture` reads canned provider responses from
`fixtures/<set>/` and performs **no network access and no credential lookup**.
Fixture references use placeholders (`tr#0`, `frame#2`, `ev#1`) that the
adapter maps to the run's system-issued IDs; unknown placeholders pass through
and fail validation normally. A fixture pass verifies pipeline mechanics only —
it says nothing about AI quality.

`--provider-mode live` requires `GOOGLE_API_KEY` (never written to disk or
logs) and calls Gemini via `@google/genai` with SDK retries disabled
(`retryOptions.attempts=1`), `responseJsonSchema` generated from the Zod
schemas, a 120 s per-attempt timeout, and the Files API for audio upload.

## Exit codes

| code | meaning |
|---|---|
| 0 | artifacts generated / repeat pass |
| 2 | input / config / schema-invalid (INVALID_MEDIA, CONFIG_INVALID, CONFIG_LANGUAGE_CONFLICT, OUTPUT_DIR_NOT_EMPTY, PROVIDER_MODE_MISMATCH, INPUT_HASH_MISMATCH, INVALID_LANGUAGE, INVALID_ARGS) |
| 3 | external dependency / provider / media-processing / internal failure (FFMPEG_NOT_FOUND, MISSING_CREDENTIALS, PROVIDER_*, DEADLINE_EXCEEDED, INTERNAL_ERROR) |
| 4 | repeat quality evaluation failed (σ > 0.5) |
| 5 | insufficient data to evaluate (NO_TRANSCRIPT, repeat not_evaluated) |

## Output layout

`manifest.json` (status last), `config.snapshot.json`, `rubric.snapshot.json`,
`prompts/<role>/*.md`, `media/audio.wav`, `media/frames/`, `transcript.json`,
`evidence-set.json`, `judge-run.json`, `attempts/`, `scorecard.json`,
`usage.json`, `evidence-audit.json`. All JSON is snake_case, `schema_version: 1`,
atomic writes via tmp+rename.

## Non-goals (Phase 0)

No DB/server, no OpenAI provider (rejected as CONFIG_INVALID), no Q&A segment
editing, no live capture, no AI-quality claims from fixture runs.
