#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';
import path from 'node:path';
import { CliError } from '../core/errors.js';
import { cmdRun } from './run.js';
import { cmdRepeat } from './repeat.js';

/**
 * judgathon CLI — Phase 0 batch pipeline.
 *
 *   judgathon run    --video <file> --rubric <yaml> --config <yaml>
 *                    [--output-language <bcp47>] [--provider-mode fixture|live]
 *                    [--fixture-dir <dir>] [--video-source screen|camera]
 *                    [--prompts-dir <dir>] [--pricing <json>] --out <dir>
 *   judgathon repeat --from <run dir> --times 5 --provider-mode <mode>
 *                    [--fixture-dir <dir>] [--output-language <bcp47>]
 *                    [--prompts-dir <dir>] --out <dir>
 *
 * stdout: one JSON line (run_id/status/artifacts or error envelope).
 * stderr: progress lines — never transcript text, never secrets.
 */

const EXIT_BY_CODE: Record<string, number> = {};

function exitCodeFor(err: CliError): number {
  return EXIT_BY_CODE[err.code] ?? err.exitCode;
}

function parseCliArgs<T extends ParseArgsConfig>(config: T) {
  try {
    return parseArgs(config);
  } catch (err) {
    // parseArgs throws TypeError with code ERR_PARSE_ARGS_* for unknown
    // options, missing values, etc. -> exit 2 INVALID_ARGS.
    const code = (err as { code?: string }).code;
    if (err instanceof TypeError && typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
      throw new CliError('INVALID_ARGS', err.message, 2, 'validate_input');
    }
    throw err;
  }
}

async function main(): Promise<number> {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'run') {
      const { values } = parseCliArgs({
        args: rest,
        options: {
          video: { type: 'string' },
          rubric: { type: 'string' },
          config: { type: 'string' },
          'output-language': { type: 'string' },
          'provider-mode': { type: 'string', default: 'fixture' },
          'fixture-dir': { type: 'string', default: 'fixtures/default' },
          'video-source': { type: 'string', default: 'screen' },
          'prompts-dir': { type: 'string', default: 'prompts' },
          pricing: { type: 'string', default: 'configs/pricing.json' },
          out: { type: 'string' },
        },
        strict: true,
      });
      const v = values;
      for (const req of ['video', 'rubric', 'config', 'out'] as const) {
        if (!v[req]) {
          throw new CliError('INVALID_ARGS', `--${req} is required`, 2, 'validate_input');
        }
      }
      if (v['provider-mode'] !== 'fixture' && v['provider-mode'] !== 'live') {
        throw new CliError('INVALID_ARGS', `--provider-mode must be fixture|live`, 2, 'validate_input');
      }
      if (v['video-source'] !== 'screen' && v['video-source'] !== 'camera') {
        throw new CliError('INVALID_ARGS', `--video-source must be screen|camera`, 2, 'validate_input');
      }
      if (v['provider-mode'] === 'live' && v['fixture-dir'] !== 'fixtures/default') {
        throw new CliError('INVALID_ARGS', `--fixture-dir is only valid with --provider-mode fixture`, 2, 'validate_input');
      }
      const res = await cmdRun({
        video: path.resolve(v['video']!),
        rubricPath: path.resolve(v['rubric']!),
        configPath: path.resolve(v['config']!),
        outDir: path.resolve(v['out']!),
        ...(v['output-language'] !== undefined ? { outputLanguage: v['output-language'] } : {}),
        providerMode: v['provider-mode'],
        fixtureDir: path.resolve(v['fixture-dir']!),
        videoSource: v['video-source'],
        promptsDir: path.resolve(v['prompts-dir']!),
        pricingPath: path.resolve(v['pricing']!),
      });
      process.stdout.write(
        JSON.stringify({
          run_id: res.runId,
          status: 'completed',
          out: res.outDir,
          artifacts: {
            manifest: path.join(res.outDir, 'manifest.json'),
            transcript: path.join(res.outDir, 'transcript.json'),
            evidence_set: path.join(res.outDir, 'evidence-set.json'),
            judge_run: path.join(res.outDir, 'judge-run.json'),
            scorecard: path.join(res.outDir, 'scorecard.json'),
            usage: path.join(res.outDir, 'usage.json'),
            evidence_audit: path.join(res.outDir, 'evidence-audit.json'),
          },
        }) + '\n',
      );
      return 0;
    }

    if (command === 'repeat') {
      const { values } = parseCliArgs({
        args: rest,
        options: {
          from: { type: 'string' },
          times: { type: 'string', default: '5' },
          'provider-mode': { type: 'string' },
          'fixture-dir': { type: 'string', default: 'fixtures/default' },
          'output-language': { type: 'string' },
          'prompts-dir': { type: 'string', default: 'prompts' },
          pricing: { type: 'string', default: 'configs/pricing.json' },
          out: { type: 'string' },
        },
        strict: true,
      });
      const v = values;
      if (!v['from'] || !v['out']) {
        throw new CliError('INVALID_ARGS', '--from and --out are required', 2, 'validate_input');
      }
      const times = Number(v['times']);
      if (!Number.isInteger(times)) {
        throw new CliError('INVALID_ARGS', '--times must be an integer', 2, 'validate_input');
      }
      if (v['provider-mode'] !== 'fixture' && v['provider-mode'] !== 'live') {
        throw new CliError('INVALID_ARGS', '--provider-mode is required (fixture|live)', 2, 'validate_input');
      }
      const res = await cmdRepeat({
        fromDir: path.resolve(v['from']),
        times,
        providerMode: v['provider-mode'],
        fixtureDir: path.resolve(v['fixture-dir']!),
        outDir: path.resolve(v['out']!),
        pricingPath: path.resolve(v['pricing']!),
        ...(v['output-language'] !== undefined ? { outputLanguage: v['output-language'] } : {}),
        promptsDir: path.resolve(v['prompts-dir']!),
      });
      process.stdout.write(
        JSON.stringify({
          status: res.status,
          report: res.reportPath,
          out: path.resolve(v['out']!),
        }) + '\n',
      );
      return res.status === 'pass' ? 0 : res.status === 'fail' ? 4 : 5;
    }

    process.stderr.write(
      'usage: judgathon <run|repeat> (see README.md)\n',
    );
    return 2;
  } catch (err) {
    const cliErr =
      err instanceof CliError
        ? err
        : new CliError('INTERNAL_ERROR', err instanceof Error ? err.message : String(err), 3, 'internal');
    const code = exitCodeFor(cliErr);
    const outDir = (process.argv.includes('--out')
      ? process.argv[process.argv.indexOf('--out') + 1]
      : undefined);
    process.stdout.write(
      JSON.stringify({
        run_id: null,
        status: 'failed',
        out: outDir ?? null,
        stage: cliErr.stage,
        error: { code: cliErr.code, message: cliErr.message },
      }) + '\n',
    );
    process.stderr.write(`[${cliErr.stage}] ${cliErr.code}: ${cliErr.message}\n`);
    return code;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  });
