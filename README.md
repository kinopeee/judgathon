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

## Commands

```bash
node scripts/make-sample-video.mjs samples/team_alpha.mp4   # synthetic 60 s sample

pnpm exec judgathon run \
  --video ./samples/team_alpha.mp4 \
  --rubric ./rubrics/hackathon-2026-v3.yaml \
  --config ./configs/judge-google-v1.yaml \
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
| 3 | external dependency / provider / media-processing failure (FFMPEG_NOT_FOUND, MISSING_CREDENTIALS, PROVIDER_*, DEADLINE_EXCEEDED) |
| 4 | repeat quality evaluation failed (σ > 0.5) |
| 5 | insufficient data to evaluate (NO_TRANSCRIPT, repeat not_evaluated) |

## Output layout

`manifest.json` (status last), `config.snapshot.json`, `rubric.snapshot.json`,
`prompts/*.md`, `media/audio.wav`, `media/frames/`, `transcript.json`,
`evidence-set.json`, `judge-run.json`, `attempts/`, `scorecard.json`,
`usage.json`, `evidence-audit.json`. All JSON is snake_case, `schema_version: 1`,
atomic writes via tmp+rename.

## Non-goals (Phase 0)

No DB/server, no OpenAI provider (rejected as CONFIG_INVALID), no Q&A segment
editing, no live capture, no AI-quality claims from fixture runs.
