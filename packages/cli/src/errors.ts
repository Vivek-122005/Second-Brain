/** Process exit codes. Documented in the README; keep them stable for scripts. */
export const ExitCode = {
  Ok: 0,
  /** Unexpected failure: API error, filesystem error. */
  Error: 1,
  /** Bad command, option or argument. */
  Usage: 2,
  /** Not signed in, or the server rejected the stored key. */
  Auth: 3,
  /** Device login was denied in the browser or the code expired. */
  LoginFailed: 4,
  /** The server could not be reached. */
  Network: 5,
} as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/** An error with a user-facing message and an exit code. Thrown by commands, printed by `run`. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = ExitCode.Error,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class UsageError extends CliError {
  constructor(message: string, hint = 'Run `brain help` for usage.') {
    super(message, ExitCode.Usage, hint);
    this.name = 'UsageError';
  }
}
