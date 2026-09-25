import type { ProjectRequirement, ParsedRequirements, RequirementParser } from '../../core/interfaces.js';

function parseGradleFile(content: string, isKts: boolean): ProjectRequirement[] {
  const requirements: ProjectRequirement[] = [];

  try {
    const lines = content.split('\n');
    const contentStr = lines.join('\n');

    for (const line of lines) {
      const trimmed = line.trim();

      const toolchainMatch = trimmed.match(/java\.toolchain\.languageVersion\s*=\s*(\d+)/);
      if (toolchainMatch && toolchainMatch[1]) {
        requirements.push({
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
        requirements.push({
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
        requirements.push({
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
      if (toolchainDslMatch && toolchainDslMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-java-toolchain-dsl`,
          ecosystem: 'java',
          type: 'runtime-version',
          name: 'java',
          versionConstraint: toolchainDslMatch[1].trim(),
          rawConstraint: toolchainDslMatch[1].trim(),
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

          requirements.push({
            id: `req-${Date.now()}-${name}-${block}`,
            ecosystem: 'java',
            type: 'package-dependency',
            name: depName,
            versionConstraint: version,
            rawConstraint: version,
            sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
            sourceSection: `dependencies.${block}`,
            developmentOnly: block.startsWith('test'),
            metadata: { group, name, configuration: block, buildTool: 'gradle' },
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

        requirements.push({
          id: `req-${Date.now()}-${name}-${configuration}`,
          ecosystem: 'java',
          type: 'package-dependency',
          name: depName,
          versionConstraint: version,
          rawConstraint: version,
          sourceFile: isKts ? 'build.gradle.kts' : 'build.gradle',
          sourceSection: `dependencies.${configuration}`,
          developmentOnly: configuration.startsWith('test'),
          metadata: { group, name, configuration, buildTool: 'gradle' },
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

        requirements.push({
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
  readonly supportedFormats = ['build.gradle', 'build.gradle.kts'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
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