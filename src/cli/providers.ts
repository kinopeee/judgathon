import { CliError } from '../core/errors.js';
import type { JudgeConfig } from '../core/schemas/config.js';
import type { Judge, ProviderSet } from '../providers/types.js';
import { FixtureExtractor, FixtureJudge, FixtureTranscriber } from '../providers/fixture/index.js';
import {
  GoogleEvidenceExtractor,
  GoogleJudge,
  GoogleTranscriber,
} from '../providers/google/index.js';

export interface ProviderModeOptions {
  providerMode: 'fixture' | 'live';
  fixtureDir: string;
}

export interface JudgeResolvers {
  evidenceIds: () => string[];
  transcriptIds: () => string[];
  inputFrameIds: () => string[];
}

function googleApiKey(): string {
  const apiKey = process.env['GOOGLE_API_KEY'];
  if (!apiKey) {
    throw new CliError(
      'MISSING_CREDENTIALS',
      'GOOGLE_API_KEY environment variable is required for --provider-mode live',
      3,
      'validate_input',
    );
  }
  return apiKey;
}

/**
 * Judge-only construction for `repeat` — scoring needs no transcriber or
 * extractor, so no ProviderSet is fabricated.
 */
export function buildJudge(
  opts: ProviderModeOptions,
  judgeEntry: JudgeConfig['judges'][number],
  resolvers: JudgeResolvers,
): Judge {
  if (opts.providerMode === 'fixture') {
    return new FixtureJudge(
      opts.fixtureDir,
      resolvers.evidenceIds,
      resolvers.transcriptIds,
      resolvers.inputFrameIds,
    );
  }
  return new GoogleJudge(judgeEntry, { apiKey: googleApiKey() });
}

/** Full three-role provider set for `run`. */
export function buildProviders(
  opts: ProviderModeOptions,
  config: JudgeConfig,
  resolvers: JudgeResolvers,
): ProviderSet {
  if (opts.providerMode === 'fixture') {
    return {
      mode: 'fixture',
      transcriber: new FixtureTranscriber(opts.fixtureDir),
      extractor: new FixtureExtractor(opts.fixtureDir, resolvers.transcriptIds),
      judge: buildJudge(opts, config.judges[0]!, resolvers),
    };
  }
  const g = { apiKey: googleApiKey() };
  return {
    mode: 'live',
    transcriber: new GoogleTranscriber(config.transcriber, g),
    extractor: new GoogleEvidenceExtractor(config.evidence_extractor, g),
    judge: new GoogleJudge(config.judges[0]!, g),
  };
}
