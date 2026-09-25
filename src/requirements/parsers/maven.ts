import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

export class MavenRequirementParser implements RequirementParser {
  readonly ecosystem = 'java';
  readonly supportedFormats = ['pom.xml', 'maven-wrapper.properties'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const fileName = sourceFile.split('/').pop()?.toLowerCase() || '';
    if (fileName === 'maven-wrapper.properties') {
      return this.parseWrapperProperties(sourceFile, content);
    }
    return this.parsePom(sourceFile, content);
  }

  private parseWrapperProperties(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    const urlMatch = content.match(/distributionUrl\s*=\s*(.+)/);
    if (urlMatch && urlMatch[1]) {
      const url = urlMatch[1].trim();
      const versionMatch = url.match(/apache-maven-([0-9][0-9A-Za-z.\-_]*)-bin/);
      requirements.push({
        id: `req-${Date.now()}-maven-wrapper`,
        ecosystem: 'java',
        type: 'toolchain',
        name: 'maven',
        versionConstraint: versionMatch && versionMatch[1] ? versionMatch[1] : undefined,
        rawConstraint: url,
        sourceFile,
        sourceSection: 'distributionUrl',
        metadata: { type: 'wrapper', buildTool: 'maven' },
      });
    }

    return { projectId: 'unknown', sourceFiles: [sourceFile], requirements, parseErrors: errors };
  }

  private extractProperties(content: string): Map<string, string> {
    const properties = new Map<string, string>();
    const blockMatch = content.match(/<properties>([\s\S]*?)<\/properties>/);
    if (!blockMatch || !blockMatch[1]) {
      return properties;
    }
    const entryRegex = /<([A-Za-z0-9_.-]+)>\s*([^<]*)\s*<\/\1>/g;
    let match;
    while ((match = entryRegex.exec(blockMatch[1])) !== null) {
      if (match[1] && match[2] !== undefined) {
        properties.set(match[1], match[2].trim());
      }
    }
    return properties;
  }

  private extractManagedBlock(content: string): { start: number; end: number } | undefined {
    const match = content.match(/<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/);
    if (!match || match.index === undefined || !match[0]) {
      return undefined;
    }
    return { start: match.index, end: match.index + match[0].length };
  }

  private parseParent(
    content: string,
    sourceFile: string,
    requirements: ProjectRequirement[],
    resolvePlaceholders: (value: string) => { value: string; unresolved: boolean }
  ): void {
    const parentMatch = content.match(/<parent>([\s\S]*?)<\/parent>/);
    if (!parentMatch || !parentMatch[1]) {
      return;
    }
    const parent = parentMatch[1];
    const groupId = parent.match(/<groupId>\s*([^<]+)\s*<\/groupId>/);
    const artifactId = parent.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/);
    const version = parent.match(/<version>\s*([^<]+)\s*<\/version>/);
    if (groupId && groupId[1] && artifactId && artifactId[1]) {
      const rawVersion = version && version[1] ? version[1].trim() : undefined;
      const resolved = rawVersion ? resolvePlaceholders(rawVersion) : undefined;
      requirements.push({
        id: `req-${Date.now()}-parent`,
        ecosystem: 'java',
        type: 'custom',
        name: `${groupId[1].trim()}:${artifactId[1].trim()} (parent)`,
        versionConstraint: resolved?.value,
        rawConstraint: rawVersion,
        sourceFile,
        sourceSection: 'parent',
        metadata: { type: 'parent-pom', buildTool: 'maven' },
      });
    }
  }

  private parsePom(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
      const properties = this.extractProperties(content);
      const resolvePlaceholders = (value: string): { value: string; unresolved: boolean } => {
        let unresolved = false;
        const resolved = value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
          const replacement = properties.get(key);
          if (replacement === undefined) {
            unresolved = true;
            return `\${${key}}`;
          }
          return replacement;
        });
        return { value: resolved, unresolved };
      };
      const javaVersionMatch = content.match(/<java\.version>\s*([^<]+)\s*<\/java\.version>/);
      if (javaVersionMatch && javaVersionMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-java-version`,
          ecosystem: 'java',
          type: 'runtime-version',
          name: 'java',
          versionConstraint: javaVersionMatch[1].trim(),
          rawConstraint: javaVersionMatch[1].trim(),
          sourceFile,
          sourceSection: 'properties.java.version',
          metadata: { type: 'runtime', buildTool: 'maven' },
        });
      }

      const sourceMatch = content.match(/<maven\.compiler\.source>\s*([^<]+)\s*<\/maven\.compiler\.source>/);
      if (sourceMatch && sourceMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-maven-source`,
          ecosystem: 'java',
          type: 'runtime-version',
          name: 'java',
          versionConstraint: sourceMatch[1].trim(),
          rawConstraint: sourceMatch[1].trim(),
          sourceFile,
          sourceSection: 'properties.maven.compiler.source',
          metadata: { type: 'compiler', buildTool: 'maven' },
        });
      }

      const targetMatch = content.match(/<maven\.compiler\.target>\s*([^<]+)\s*<\/maven\.compiler\.target>/);
      if (targetMatch && targetMatch[1]) {
        requirements.push({
          id: `req-${Date.now()}-maven-target`,
          ecosystem: 'java',
          type: 'runtime-version',
          name: 'java',
          versionConstraint: targetMatch[1].trim(),
          rawConstraint: targetMatch[1].trim(),
          sourceFile,
          sourceSection: 'properties.maven.compiler.target',
          metadata: { type: 'compiler', buildTool: 'maven' },
        });
      }

      const compilerPluginMatch = content.match(/<artifactId>maven-compiler-plugin<\/artifactId>[\s\S]*?<configuration>([\s\S]*?)<\/configuration>/);
      if (compilerPluginMatch && compilerPluginMatch[1]) {
        const config = compilerPluginMatch[1];
        const releaseMatch = config.match(/<release>\s*([^<]+)\s*<\/release>/);
        if (releaseMatch && releaseMatch[1]) {
          requirements.push({
            id: `req-${Date.now()}-maven-release`,
            ecosystem: 'java',
            type: 'runtime-version',
            name: 'java',
            versionConstraint: releaseMatch[1].trim(),
            rawConstraint: releaseMatch[1].trim(),
            sourceFile,
            sourceSection: 'build.plugins.maven-compiler-plugin.configuration.release',
            metadata: { type: 'compiler', buildTool: 'maven' },
          });
        }
      }

      const dependencyRegex = /<dependency>([\s\S]*?)<\/dependency>/g;
      let match;
      const managedContent = this.extractManagedBlock(content);
      while ((match = dependencyRegex.exec(content)) !== null) {
        if (match.index === undefined) {
          continue;
        }
        if (managedContent && match.index >= managedContent.start && match.index < managedContent.end) {
          continue;
        }
        const depContent = match[1] || '';
        const groupIdMatch = depContent.match(/<groupId>\s*([^<]+)\s*<\/groupId>/);
        const artifactIdMatch = depContent.match(/<artifactId>\s*([^<]+)\s*<\/artifactId>/);
        const versionMatch = depContent.match(/<version>\s*([^<]+)\s*<\/version>/);
        const scopeMatch = depContent.match(/<scope>\s*([^<]+)\s*<\/scope>/);
        const optionalMatch = depContent.match(/<optional>\s*true\s*<\/optional>/);

        if (groupIdMatch && groupIdMatch[1] && artifactIdMatch && artifactIdMatch[1]) {
          const groupId = groupIdMatch[1].trim();
          const artifactId = artifactIdMatch[1].trim();
          const name = `${groupId}:${artifactId}`;
          const rawVersion = versionMatch && versionMatch[1] ? versionMatch[1].trim() : undefined;
          const resolved = rawVersion ? resolvePlaceholders(rawVersion) : undefined;
          const scope = scopeMatch && scopeMatch[1] ? scopeMatch[1].trim() : 'compile';
          const optional = !!optionalMatch;

          requirements.push({
            id: `req-${Date.now()}-${artifactId}`,
            ecosystem: 'java',
            type: 'package-dependency',
            name,
            versionConstraint: resolved?.value,
            rawConstraint: rawVersion,
            sourceFile,
            sourceSection: 'dependencies',
            optional,
            developmentOnly: scope === 'test' || scope === 'provided',
            metadata: {
              groupId,
              artifactId,
              scope,
              buildTool: 'maven',
              ...(resolved?.unresolved ? { unresolvedVersion: true } : {}),
            },
          });
        }
      }

      this.parseParent(content, sourceFile, requirements, resolvePlaceholders);

    } catch (err) {
      errors.push({
        sourceFile,
        error: `Failed to parse pom.xml: ${err instanceof Error ? err.message : String(err)}`,
        code: 'PARSE_ERROR',
        severity: 'error',
      });
    }

    return {
      projectId: 'unknown',
      sourceFiles: [sourceFile],
      requirements,
      parseErrors: errors,
    };
  }
}