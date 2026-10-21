import { parseArgs } from 'node:util';
import { keys } from './commands/keys';
import { login } from './commands/login';
import { logout } from './commands/logout';
import { status } from './commands/status';
import type { Ctx } from './context';
import { CliError, ExitCode, UsageError } from './errors';
import { Output } from './output';
import { VERSION } from './version';

const OPTIONS = {
  api: { type: 'string' },
  client: { type: 'string' },
  machine: { type: 'string' },
  'no-browser': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const;

type OptionName = keyof typeof OPTIONS;

interface CommandSpec {
  summary: string;
  usage: string;
  options: OptionName[];
  details?: string;
}

const COMMANDS: Record<string, CommandSpec> = {
  login: {
    summary: 'Sign this machine in (opens the browser) and store its key',
    usage: 'brain login [--api <url>] [--client <name>] [--machine <name>] [--no-browser]',
    options: ['api', 'client', 'machine', 'no-browser'],
    details: [
      'Options:',
      '  --api <url>        Server URL (default: $SECOND_BRAIN_API_URL, saved config, http://localhost:8787)',
      '  --client <name>    Client name recorded on the key (default: cli)',
      '  --machine <name>   Machine name recorded on the key (default: this hostname)',
      '  --no-browser       Print the link instead of opening it',
    ].join('\n'),
  },
  logout: {
    summary: 'Revoke this machine’s key and delete it from the keychain',
    usage: 'brain logout [--api <url>]',
    options: ['api'],
  },
  status: {
    summary: 'Show the server, signed-in user and key (never the secret)',
    usage: 'brain status [--api <url>]',
    options: ['api'],
  },
  keys: {
    summary: 'List your API keys',
    usage: 'brain keys [--api <url>]',
    options: ['api'],
  },
  help: {
    summary: 'Show help for brain or a command',
    usage: 'brain help [command]',
    options: [],
  },
};

function mainHelp(out: Output): void {
  const c = out.c;
  out.line(`${c.bold('brain')} ${c.dim(VERSION)}: Second Brain from the command line`);
  out.line();
  out.line(`${c.bold('Usage')}  brain <command> [options]`);
  out.line();
  out.line(c.bold('Commands'));
  const width = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  for (const [name, spec] of Object.entries(COMMANDS)) {
    out.line(`  ${name.padEnd(width)}  ${spec.summary}`);
  }
  out.line();
  out.line(c.bold('Examples'));
  out.line('  brain login --api https://brain.example.com');
  out.line('  brain status');
  out.line();
  out.line(c.dim('Run `brain help <command>` for details. Docs: packages/cli/README.md'));
}

function commandHelp(out: Output, name: string): void {
  const spec = COMMANDS[name]!;
  out.line(spec.summary + '.');
  out.line();
  out.line(`${out.c.bold('Usage')}  ${spec.usage}`);
  if (spec.details) {
    out.line();
    out.line(spec.details);
  }
}

/** Runs the CLI and returns the process exit code. Never calls `process.exit`. */
export async function run(argv: string[], ctx: Ctx): Promise<number> {
  const out = Output.fromCtx(ctx);
  try {
    return await dispatch(argv, ctx, out);
  } catch (err) {
    if (err instanceof CliError) {
      out.error(err.message, err.hint);
      return err.exitCode;
    }
    const message = err instanceof Error ? err.message : String(err);
    out.error(`Unexpected error: ${message}`);
    if (ctx.env.SECOND_BRAIN_DEBUG === '1' && err instanceof Error && err.stack) {
      ctx.stderr.write(out.scrub(err.stack) + '\n');
    }
    return ExitCode.Error;
  }
}

async function dispatch(argv: string[], ctx: Ctx, out: Output): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError((err as Error).message.replace(/\. To specify.*$/s, '.'));
  }
  const { values, positionals } = parsed;
  const [command, ...rest] = positionals;

  if (values.version && !command) {
    out.line(VERSION);
    return ExitCode.Ok;
  }
  if (!command) {
    mainHelp(out);
    return values.help ? ExitCode.Ok : ExitCode.Usage;
  }
  const spec = COMMANDS[command];
  if (!spec) {
    const close = Object.keys(COMMANDS).find((k) => k.startsWith(command.slice(0, 3)));
    throw new UsageError(
      `Unknown command "${command}".`,
      close ? `Did you mean \`brain ${close}\`? Run \`brain help\` for all commands.` : undefined,
    );
  }
  if (command === 'help') {
    const topic = rest[0];
    if (topic && COMMANDS[topic]) commandHelp(out, topic);
    else if (topic) throw new UsageError(`Unknown command "${topic}".`);
    else mainHelp(out);
    return ExitCode.Ok;
  }
  if (values.help) {
    commandHelp(out, command);
    return ExitCode.Ok;
  }

  for (const key of Object.keys(values) as OptionName[]) {
    if (key === 'help' || key === 'version') continue;
    if (!spec.options.includes(key)) {
      throw new UsageError(`\`brain ${command}\` does not take --${key}.`, `Usage: ${spec.usage}`);
    }
  }
  const maxPositionals = 0;
  if (rest.length > maxPositionals) {
    throw new UsageError(`Unexpected argument "${rest[maxPositionals]}".`, `Usage: ${spec.usage}`);
  }

  switch (command) {
    case 'login':
      await login(ctx, out, {
        api: values.api,
        client: values.client,
        machine: values.machine,
        browser: !values['no-browser'],
      });
      break;
    case 'logout':
      await logout(ctx, out, { api: values.api });
      break;
    case 'status':
      await status(ctx, out, { api: values.api });
      break;
    case 'keys':
      await keys(ctx, out, { api: values.api });
      break;
  }
  return ExitCode.Ok;
}
