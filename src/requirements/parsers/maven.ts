import type { ProjectRequirement, ParsedRequirements, RequirementParseError, RequirementParser } from '../../core/interfaces.js';

export class MavenRequirementParser implements RequirementParser {
  readonly ecosystem = 'java';
  readonly supportedFormats = ['pom.xml'];

  canParse(fileName: string): boolean {
    return this.supportedFormats.includes(fileName.toLowerCase());
  }

  parse(sourceFile: string, content: string): ParsedRequirements {
    const requirements: ProjectRequirement[] = [];
    const errors: RequirementParseError[] = [];

    try {
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
      while ((match = dependencyRegex.exec(content)) !== null) {
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
          const version = versionMatch && versionMatch[1] ? versionMatch[1].trim() : undefined;
          const scope = scopeMatch && scopeMatch[1] ? scopeMatch[1].trim() : 'compile';
          const optional = !!optionalMatch;

          requirements.push({
            id: `req-${Date.now()}-${artifactId}`,
            ecosystem: 'java',
            type: 'package-dependency',
            name,
            versionConstraint: version,
            rawConstraint: version,
            sourceFile,
            sourceSection: 'dependencies',
            optional,
            developmentOnly: scope === 'test' || scope === 'provided',
            metadata: { groupId, artifactId, scope, buildTool: 'maven' },
          });
        }
      }

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