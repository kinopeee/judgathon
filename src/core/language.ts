import { CliError, type ExitCode } from './errors.js';

/** Canonical BCP 47 tag via Intl; throws CliError when the tag is invalid. */
export function canonicalBcp47Tag(
  tag: string,
  err: { code: string; message: string; exitCode: ExitCode; stage: string },
): string {
  try {
    return Intl.getCanonicalLocales(tag)[0]!;
  } catch {
    throw new CliError(err.code, err.message, err.exitCode, err.stage);
  }
}
