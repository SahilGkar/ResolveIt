import type { ProjectRequirement, ParsedRequirements, RequirementParser } from '../../core/interfaces.js';

function parseGradleFile(content: string, isKts: boolean): ProjectRequirement[] {
  const requirements: ProjectRequirement[] = [];
  const seen = new Set<string>();

  const push = (requirement: ProjectRequirement): void => {
    const key = `${requirement.type}|${requirement.name}|${requirement.versionConstraint ?? ''}|${requirement.sourceSection ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      requirements.push(requirement);
    }
  };

  const dynamicMetadata = (version: string | undefined): Record<string, unknown> => {
    if (version && (/\+/.test(version) || /^(latest|release)/i.test(version) || version.startsWith('['))) {
      return { dynamic: true };
    }
    return {};
  };

  try {
    const lines = content.split('\n');
    const contentStr = lines.join('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      const toolchainMatch = trimmed.match(/java\.toolchain\.languageVersion\s*=\s*(\d+)/);
      if (toolchainMatch && toolchainMatch[1]) {
        push({
          id: `req-${Date.now()}-java-toolchain`,
          ecosystem: 'java',
          type: 'runtime-version',
          name: 'java',
          versionConstraint: toolchainMatch[1].trim(),
          rawConstraint: toolchainMatch[1].trim(),
          sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
          sourceSection: 'java.toolchain.languageVersion',
          metadata: { type: 'toolchain', buildTool: 'gradle' },
        });
      }

      const sourceCompatMatch = trimmed.match(/sourceCompatibility\s*=\s*['"]([^'"]+)['"]/);
      if (sourceCompatMatch && sourceCompatMatch[1]) {
        push({
          id: `req-${Date.now()}-source-compat`,
          ecosystem: 'java',
          type: 'runtime-version',
          name: 'java',
          versionConstraint: sourceCompatMatch[1].trim(),
          rawConstraint: sourceCompatMatch[1].trim(),
          sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
          sourceSection: 'sourceCompatibility',
          metadata: { type: 'compiler', buildTool: 'gradle' },
        });
      }

      const targetCompatMatch = trimmed.match(/targetCompatibility\s*=\s*['"]([^'"]+)['"]/);
      if (targetCompatMatch && targetCompatMatch[1]) {
        push({
          id: `req-${Date.now()}-target-compat`,
          ecosystem: 'java',
          type: 'runtime-version',
          name: 'java',
          versionConstraint: targetCompatMatch[1].trim(),
          rawConstraint: targetCompatMatch[1].trim(),
          sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
          sourceSection: 'targetCompatibility',
          metadata: { type: 'compiler', buildTool: 'gradle' },
        });
      }

      const toolchainDslMatch = trimmed.match(/java\s*\{[\s\S]*?toolchain\s*\{[\s\S]*?languageVersion\s*=\s*(\d+)/);
      const toolchainOfMatch = trimmed.match(/JavaLanguageVersion\.of\s*\(\s*(\d+)\s*\)/);
      const toolchainVersion = toolchainDslMatch?.[1] ?? toolchainOfMatch?.[1];
      if (toolchainVersion) {
        push({
          id: `req-${Date.now()}-java-toolchain-dsl`,
          ecosystem: 'java',
          type: 'runtime-version',
          name: 'java',
          versionConstraint: toolchainVersion.trim(),
          rawConstraint: toolchainVersion.trim(),
          sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
          sourceSection: 'java.toolchain',
          metadata: { type: 'toolchain', buildTool: 'gradle' },
        });
      }
    }

    const depBlocks = ['implementation', 'api', 'compileOnly', 'runtimeOnly', 'testImplementation', 'testCompileOnly', 'testRuntimeOnly', 'compile', 'runtime', 'testCompile', 'testRuntime'];

    for (const block of depBlocks) {
      const blockRegex = new RegExp(`${block}\\s+\\(?['"]([^:'")]+):([^:'"]+):([^'")]+)['"]\\)?`, 'g');
      let match;
      while ((match = blockRegex.exec(contentStr)) !== null) {
        const group = match[1];
        const name = match[2];
        const version = match[3];
        if (group && name && version) {
          const depName = `${group}:${name}`;

          push({
            id: `req-${Date.now()}-${name}-${block}`,
            ecosystem: 'java',
            type: 'package-dependency',
            name: depName,
            versionConstraint: version,
            rawConstraint: version,
            sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
            sourceSection: `dependencies.${block}`,
            developmentOnly: block.startsWith('test'),
            metadata: { group, name, configuration: block, buildTool: 'gradle', ...dynamicMetadata(version) },
          });
        }
      }
    }

    const simpleDepRegex = /(\w+)\s+["']([^:'"]+):([^:'"]+):([^'"]+)["']/g;
    let match;
    while ((match = simpleDepRegex.exec(contentStr)) !== null) {
      const configuration = match[1];
      const group = match[2];
      const name = match[3];
      const version = match[4];
      if (configuration && group && name && version) {
        const depName = `${group}:${name}`;

        push({
          id: `req-${Date.now()}-${name}-${configuration}`,
          ecosystem: 'java',
          type: 'package-dependency',
          name: depName,
          versionConstraint: version,
          rawConstraint: version,
          sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
            sourceSection: `dependencies.${configuration}`,
            developmentOnly: configuration.startsWith('test'),
            metadata: { group, name, configuration, buildTool: 'gradle', ...dynamicMetadata(version) },
          });
      }
    }

    const platformRegex = /(platform|enforcedPlatform)\s*\(?["']([^:'"]+):([^:'"]+):([^'"]+)["']\)?/g;
    while ((match = platformRegex.exec(contentStr)) !== null) {
      const type = match[1];
      const group = match[2];
      const name = match[3];
      const version = match[4];
      if (type && group && name && version) {
        const depName = `${group}:${name}`;

        push({
          id: `req-${Date.now()}-${name}-platform`,
          ecosystem: 'java',
          type: 'package-dependency',
          name: depName,
          versionConstraint: version,
          rawConstraint: version,
          sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
          sourceSection: `dependencies.${type}`,
          optional: true,
          metadata: { group, name, type: 'platform', buildTool: 'gradle' },
        });
      }
    }

  } catch (err) {
    // Ignore parse errors
  }

  return requirements;
}

export class GradleRequirementParser implements RequirementParser {
  readonly ecosystem = 'java';
  readonly supportedFormats = [
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle-wrapper.properties',
    'libs.versions.toml',
  ];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';
    if (fileName === 'gradle-wrapper.properties') {
      return parseGradleWrapper(sourceFile, content);
    }
    if (fileName === 'libs.versions.toml') {
      return parseVersionCatalog(sourceFile, content);
    }
    const isKts = sourceFile.endsWith('.kts');
    const requirements = parseGradleFile(content, isKts);
    return {
      projectId: 'unknown',
      sourceFiles: [sourceFile],
      requirements,
      parseErrors: [],
    };
  }
}

function parseGradleWrapper(sourceFile: string, content: string): ParsedRequirements {
  const requirements: ProjectRequirement[] = [];
  const urlMatch = content.match(/distributionUrl\s*=\s*(.+)/);
  if (urlMatch && urlMatch[1]) {
    const url = urlMatch[1].trim();
    const versionMatch = url.match(/gradle-([0-9][0-9A-Za-z.\-_]*)-bin/);
    requirements.push({
      id: `req-${Date.now()}-gradle-wrapper`,
      ecosystem: 'java',
      type: 'toolchain',
      name: 'gradle',
      versionConstraint: versionMatch && versionMatch[1] ? versionMatch[1] : undefined,
      rawConstraint: url,
      sourceFile,
      sourceSection: 'distributionUrl',
      metadata: { type: 'wrapper', buildTool: 'gradle' },
    });
  }
  return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: [] };
}

function parseVersionCatalog(sourceFile: string, content: string): ParsedRequirements {
  const requirements: ProjectRequirement[] = [];
  const versions = new Map<string, string>();
  let section = '';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch && sectionMatch[1]) {
      section = sectionMatch[1].trim().toLowerCase();
      continue;
    }
    if (section === 'versions') {
      const entryMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*["']?([^"'#\s]+)["']?/);
      if (entryMatch && entryMatch[1] && entryMatch[2] !== undefined) {
        versions.set(entryMatch[1], entryMatch[2].trim());
      }
    } else if (section === 'libraries') {
      const entryMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
      if (entryMatch && entryMatch[1] && entryMatch[2] !== undefined) {
        const alias = entryMatch[1];
        const spec = entryMatch[2].trim();
        const shortMatch = spec.match(/^["']([^:'"]+):([^:'"]+):([^'"]+)["']$/);
        if (shortMatch && shortMatch[1] && shortMatch[2] && shortMatch[3]) {
          requirements.push({
            id: `req-${Date.now()}-${shortMatch[2]}-catalog`,
            ecosystem: 'java',
            type: 'package-dependency',
            name: `${shortMatch[1]}:${shortMatch[2]}`,
            versionConstraint: shortMatch[3],
            rawConstraint: shortMatch[3],
            sourceFile,
            sourceSection: `libraries.${alias}`,
            metadata: { alias, buildTool: 'gradle', catalog: true },
          });
          continue;
        }
        const moduleMatch = spec.match(/module\s*=\s*["']([^:'"]+):([^'"]+)["']/);
        const versionRefMatch = spec.match(/version\.ref\s*=\s*["']?([^"',}\s]+)["']?/);
        const versionLiteralMatch = spec.match(/version\s*=\s*["']([^'"]+)["']/);
        if (moduleMatch && moduleMatch[1] && moduleMatch[2]) {
          const ref = versionRefMatch && versionRefMatch[1] ? versions.get(versionRefMatch[1]) : undefined;
          const version =
            versionLiteralMatch && versionLiteralMatch[1]
              ? versionLiteralMatch[1]
              : ref ?? (versionRefMatch && versionRefMatch[1] ? `\${${versionRefMatch[1]}}` : undefined);
          requirements.push({
            id: `req-${Date.now()}-${moduleMatch[2]}-catalog`,
            ecosystem: 'java',
            type: 'package-dependency',
            name: `${moduleMatch[1]}:${moduleMatch[2]}`,
            versionConstraint: version,
            rawConstraint: version,
            sourceFile,
            sourceSection: `libraries.${alias}`,
            metadata: {
              alias,
              buildTool: 'gradle',
              catalog: true,
              ...(version && version.includes('${') ? { unresolvedVersion: true } : {}),
            },
          });
        }
      }
    }
  }

  return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: [] };
}