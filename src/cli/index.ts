import { Command } from 'commander';
import { version } from '../version.js';

export const program = new Command();

program
  .name('resolveit')
  .description('Language-agnostic IDE-integrated project environment diagnosis and resolution system')
  .version(version)
  .helpOption('-h, --help', 'Display help for command')
  .exitOverride();

program
  .command('version')
  .description('Display version information')
  .action(() => {
    console.log(`ResolveIt v${version}`);
  });

program
  .command('help')
  .description('Display help')
  .action(() => {
    program.help();
  });

export function runCli(args: string[] = process.argv.slice(2)): void {
  try {
    program.parse(args, { from: 'user' });
  } catch (err: any) {
    if (err.code === 'commander.help' || err.code === 'commander.version') {
      return;
    }
    throw err;
  }

  if (!args.length) {
    program.help();
  }
}

if (require.main === module) {
  runCli();
}