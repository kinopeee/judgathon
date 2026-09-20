export type ExitCode = 0 | 2 | 3 | 4 | 5;

/** An error that maps to a CLI exit code and a pipeline stage. */
export class CliError extends Error {
  readonly code: string;
  readonly exitCode: ExitCode;
  readonly stage: string;

  constructor(code: string, message: string, exitCode: ExitCode, stage: string) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.exitCode = exitCode;
    this.stage = stage;
  }
}

export type ProviderErrorKind =
  | 'timeout'
  | 'rate_limited'
  | 'server'
  | 'auth'
  | 'invalid_input'
  | 'other';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly httpStatus?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    opts?: { httpStatus?: number; retryAfterMs?: number },
  ) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    if (opts?.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
    if (opts?.retryAfterMs !== undefined) this.retryAfterMs = opts.retryAfterMs;
  }
}

export function isRetryableProviderError(err: ProviderError): boolean {
  return err.kind === 'timeout' || err.kind === 'rate_limited' || err.kind === 'server';
}
