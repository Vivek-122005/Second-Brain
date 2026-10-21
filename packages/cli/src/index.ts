import { defaultContext } from './context';
import { run } from './main';

// The shebang is added by tsup (see tsup.config.ts).
const code = await run(process.argv.slice(2), defaultContext());
process.exitCode = code;
