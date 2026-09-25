// Deterministic packaging validation for the ResolveIt VS Code extension.
// Checks manifest/code parity and package hygiene without publishing anything.
// Run: npm run validate-package
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf-8'));
}

export function extractStringArray(source, name) {
  const match = source.match(new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`));
  if (!match) {
    return [];
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

export function checkManifestParity(manifest, extensionSource) {
  const problems = [];
  const commandIds = extractStringArray(extensionSource, 'COMMAND_IDS');
  const viewIds = extractStringArray(extensionSource, 'VIEW_IDS');

  const manifestCommands = (manifest.contributes?.commands ?? []).map((command) => command.command);
  for (const id of commandIds) {
    if (!manifestCommands.includes(id)) {
      problems.push(`command ${id} is registered but missing from package.json contributes.commands`);
    }
  }
  for (const id of manifestCommands) {
    if (!commandIds.includes(id)) {
      problems.push(`command ${id} is contributed but has no registered handler`);
    }
  }

  const manifestViews = (manifest.contributes?.views?.explorer ?? []).map((view) => view.id);
  for (const id of viewIds) {
    if (!manifestViews.includes(id)) {
      problems.push(`view ${id} is registered but missing from package.json contributes.views`);
    }
  }
  for (const id of manifestViews) {
    if (!viewIds.includes(id)) {
      problems.push(`view ${id} is contributed but has no registered provider`);
    }
  }

  for (const id of commandIds) {
    const event = `onCommand:${id}`;
    if (!(manifest.activationEvents ?? []).includes(event)) {
      problems.push(`missing activation event ${event}`);
    }
  }

  const expectedSettings = [
    'resolveit.ai.provider',
    'resolveit.ai.model',
    'resolveit.ai.baseUrl',
    'resolveit.ai.timeout',
    'resolveit.maxIterations',
  ];
  const actualSettings = Object.keys(manifest.contributes?.configuration?.properties ?? {});
  for (const key of expectedSettings) {
    if (!actualSettings.includes(key)) {
      problems.push(`missing configuration contribution ${key}`);
    }
    if (/apikey|api_key|secret|token|password/i.test(key)) {
      problems.push(`configuration ${key} looks like a secret and must stay environment-only`);
    }
  }
  for (const key of actualSettings) {
    if (!expectedSettings.includes(key)) {
      problems.push(`configuration ${key} is contributed but not consumed by the extension`);
    }
  }

  if (manifest.main !== './dist/extension.js') {
    problems.push(`unexpected extension entry point: ${manifest.main}`);
  }
  return problems;
}

export function checkPackageHygiene(listFiles) {
  const problems = [];
  for (const file of listFiles) {
    if (/(^|\/)tests?\//.test(file) || /\.test\.(ts|js)$/.test(file)) {
      problems.push(`test artifact would be shipped: ${file}`);
    }
    if (/vscode-mock/.test(file)) {
      problems.push(`test mock would be shipped: ${file}`);
    }
    if (/\.ts$/.test(file) && !/\.d\.ts$/.test(file)) {
      problems.push(`TypeScript source would be shipped: ${file}`);
    }
    if (/(^|\/)node_modules\//.test(file)) {
      problems.push(`node_modules content would be shipped: ${file}`);
    }
    if (/\.env(\.|$)/.test(file) || /apikey|secret/i.test(file)) {
      problems.push(`sensitive-looking file would be shipped: ${file}`);
    }
  }
  return problems;
}

function listPackageFiles() {
  const ignore = readFileSync(join(root, '.vscodeignore'), 'utf-8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const files = [];
  const walk = (dir, relative) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const rel = relative ? `${relative}/${entry}` : entry;
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist') {
          files.push(`${rel}/`);
          continue;
        }
        walk(full, rel);
        continue;
      }
      files.push(rel);
    }
  };
  walk(root, '');
  return files.filter((file) => {
    if (file === 'dist/extension.js' || file === 'package.json' || file === 'README.md' || file === 'LICENSE') {
      return true;
    }
    return !ignore.some((pattern) => {
      const normalized = pattern.replace(/\/\*\*$/, '/').replace(/^\*\*\//, '');
      if (pattern.endsWith('/**')) {
        return file.startsWith(normalized);
      }
      if (pattern.startsWith('**/')) {
        return file.endsWith(normalized) || file.includes(`/${normalized}`);
      }
      return file === normalized || file.startsWith(`${normalized}/`);
    });
  });
}

export function validatePackage() {
  const problems = [];
  const manifest = readJson(join(root, 'package.json'));
  const extensionSource = readFileSync(join(root, 'src', 'extension.ts'), 'utf-8');
  problems.push(...checkManifestParity(manifest, extensionSource));

  if (!existsSync(join(root, 'dist', 'extension.js'))) {
    problems.push('dist/extension.js is missing; run npm run build first');
  } else {
    const bundle = readFileSync(join(root, 'dist', 'extension.js'), 'utf-8');
    for (const id of extractStringArray(extensionSource, 'COMMAND_IDS')) {
      if (!bundle.includes(id)) {
        problems.push(`bundle is missing command id ${id}; rebuild before packaging`);
      }
    }
    if (/vscode-mock/.test(bundle)) {
      problems.push('bundle contains test mock code');
    }
  }

  if (!existsSync(join(root, '.vscodeignore'))) {
    problems.push('.vscodeignore is missing');
  } else {
    problems.push(...checkPackageHygiene(listPackageFiles()));
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const problems = validatePackage();
  if (problems.length > 0) {
    console.error('Packaging validation failed:');
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log('Packaging validation passed.');
}
