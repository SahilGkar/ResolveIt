import { promises as fs } from 'fs';
import { basename } from 'path';
import type { Diagnostic, DiagnosticRule, DiagnosticContext, DiagnosticSeverity, DiagnosticEvidence } from '../../core/interfaces.js';
import { checkWorkspaceContainment } from '../../safety/paths.js';
import { SECURITY_LIMITS, truncateText } from '../../safety/limits.js';
import { createDiagnosticId } from '../../safety/ids.js';

const COMPOSE_BASENAMES = new Set([
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
]);

function isDockerfileName(relativePath: string): boolean {
  const base = basename(relativePath).toLowerCase();
  return (
    base === 'dockerfile' ||
    base === 'containerfile' ||
    base.startsWith('dockerfile.') ||
    base.endsWith('.dockerfile')
  );
}

function isComposeFileName(relativePath: string): boolean {
  return COMPOSE_BASENAMES.has(basename(relativePath).toLowerCase());
}

interface SecurityCheck {
  readonly code: string;
  readonly severity: DiagnosticSeverity;
  readonly title: string;
  readonly message: string;
  readonly remediation: string;
}

function finding(
  check: SecurityCheck,
  file: string,
  line: number,
  observed: string
): Diagnostic {
  const evidence: DiagnosticEvidence[] = [
    {
      source: 'project',
      description: `Observed in ${file}:${line}: ${truncateText(observed.trim(), 240)}`,
      file,
      section: `line ${line}`,
    },
  ];
  return {
    id: createDiagnosticId(),
    code: check.code,
    severity: check.severity,
    category: 'container',
    title: `${check.title} (${file}:${line})`,
    message: check.message,
    evidence,
    affectedFiles: [file],
    source: 'dependency-resolver',
    timestamp: new Date(),
    metadata: { ecosystem: 'docker', type: 'security', remediation: check.remediation },
  };
}

const PRIVILEGED: SecurityCheck = {
  code: 'CONTAINER_PRIVILEGED_MODE',
  severity: 'critical',
  title: 'Privileged container mode',
  message: 'A service runs with privileged access, granting broad host capabilities.',
  remediation: 'Remove privileged mode unless strictly required; prefer adding only the capabilities the service needs.',
};

const DOCKER_SOCKET: SecurityCheck = {
  code: 'CONTAINER_DOCKER_SOCKET',
  severity: 'critical',
  title: 'Docker socket mounted into container',
  message: 'The Docker daemon socket is mounted into a container, allowing control of the host Docker daemon.',
  remediation: 'Remove the Docker socket mount. If container orchestration is needed, use a restricted proxy with a read-only socket.',
};

function hostMountCheck(path: string): SecurityCheck {
  const broad = path === '/' || /^\/(etc|usr|var|root|home|opt|sys|proc|boot|dev)(\/|$)/.test(path);
  return {
    code: 'CONTAINER_HOST_MOUNT',
    severity: broad ? 'error' : 'warning',
    title: 'Broad host filesystem mount',
    message: `A service mounts host path ${path} into a container.`,
    remediation: 'Replace the broad host mount with a narrower project directory volume.',
  };
}

const HOST_NETWORK: SecurityCheck = {
  code: 'CONTAINER_HOST_NETWORK',
  severity: 'error',
  title: 'Host networking enabled',
  message: 'A service shares the host network namespace.',
  remediation: 'Use explicit port mappings instead of host networking.',
};

const HOST_PID_IPC: SecurityCheck = {
  code: 'CONTAINER_HOST_PID_IPC',
  severity: 'error',
  title: 'Host PID or IPC namespace shared',
  message: 'A service shares the host PID or IPC namespace.',
  remediation: 'Remove pid/host or ipc/host sharing unless strictly required.',
};

function capabilityCheck(capability: string): SecurityCheck {
  return {
    code: 'CONTAINER_DANGEROUS_CAPABILITY',
    severity: 'error',
    title: `Dangerous Linux capability granted: ${capability}`,
    message: `A service is granted the ${capability} capability, which weakens container isolation.`,
    remediation: 'Drop unnecessary capabilities; add back only the minimum set the service needs.',
  };
}

function unpinnedImageCheck(image: string): SecurityCheck {
  return {
    code: 'CONTAINER_UNPINNED_IMAGE',
    severity: 'warning',
    title: `Unpinned container image: ${image}`,
    message: `Image ${image} is not pinned to a digest, weakening reproducibility. This is a posture observation only.`,
    remediation: 'Pin the image to a digest (image@sha256:...) for reproducible deployments.',
  };
}

const BROAD_BUILD_CONTEXT: SecurityCheck = {
  code: 'CONTAINER_BROAD_BUILD_CONTEXT',
  severity: 'warning',
  title: 'Broad Docker build context',
  message: 'A build context covers the repository root or a parent directory, sending more files than necessary to the builder.',
  remediation: 'Narrow the build context to the service directory and use a .dockerignore file.',
};

const DANGEROUS_CAPABILITIES = new Set([
  'SYS_ADMIN',
  'NET_ADMIN',
  'SYS_PTRACE',
  'SYS_MODULE',
  'SYS_RAWIO',
  'SYS_BOOT',
  'MKNOD',
  'NET_RAW',
  'SYSLOG',
  'ALL',
]);

const SENSITIVE_HOST_DIRS = ['etc', 'usr', 'var', 'root', 'home', 'opt', 'sys', 'proc', 'boot', 'dev'];

function volumeHostSource(entry: string): string | undefined {
  const cleaned = entry.replace(/^["']|["']$/g, '').trim();
  if (!cleaned.startsWith('/')) {
    return undefined;
  }
  const parts = cleaned.split(':');
  const source = (parts[0] ?? '').trim();
  if (source === '' || source === '.' || source === '~') {
    return undefined;
  }
  return source;
}

function isBroadHostSource(source: string): 'error' | 'warning' | undefined {
  if (source === '/') {
    return 'error';
  }
  const first = source.slice(1).split('/')[0] ?? '';
  if (SENSITIVE_HOST_DIRS.includes(first.toLowerCase())) {
    return 'error';
  }
  return 'warning';
}

function parseImageRef(spec: string): { name: string; pinned: boolean } {
  const digestSplit = spec.split('@');
  if (digestSplit.length > 1 && /sha256:/.test(digestSplit.slice(1).join('@'))) {
    return { name: digestSplit[0] ?? spec, pinned: true };
  }
  const nameTag = digestSplit[0] ?? spec;
  const lastSlash = nameTag.lastIndexOf('/');
  const lastColon = nameTag.lastIndexOf(':');
  if (lastColon <= lastSlash) {
    return { name: nameTag, pinned: false };
  }
  const tag = nameTag.slice(lastColon + 1);
  if (tag === '' || tag.toLowerCase() === 'latest') {
    return { name: nameTag, pinned: false };
  }
  return { name: nameTag, pinned: true };
}

function analyzeComposeLines(lines: string[], file: string, push: (diagnostic: Diagnostic) => void): void {
  let inCapAdd = false;
  let capAddIndent = -1;

  const indentOf = (raw: string): number => {
    const match = raw.match(/^(\s*)\S/);
    return match && match[1] !== undefined ? match[1].length : -1;
  };

  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const indent = indentOf(raw);
    const lower = trimmed.toLowerCase();

    if (lower.startsWith('cap_add:')) {
      inCapAdd = true;
      capAddIndent = indent;
      const inline = trimmed.slice('cap_add:'.length).trim();
      if (inline.startsWith('[')) {
        for (const cap of inline.replace(/[[\]]/g, '').split(',')) {
          const name = cap.trim().replace(/^["']|["']$/g, '').toUpperCase();
          if (DANGEROUS_CAPABILITIES.has(name)) {
            push(finding(capabilityCheck(name), file, line, raw));
          }
        }
        inCapAdd = false;
      }
      return;
    }
    if (inCapAdd) {
      if (trimmed.startsWith('-') && indent > capAddIndent) {
        const name = trimmed.slice(1).trim().replace(/^["']|["']$/g, '').toUpperCase();
        if (DANGEROUS_CAPABILITIES.has(name)) {
          push(finding(capabilityCheck(name), file, line, raw));
        }
        return;
      }
      if (!trimmed.startsWith('-') || indent <= capAddIndent) {
        inCapAdd = false;
      }
    }

    if (/^privileged\s*:\s*true/i.test(trimmed)) {
      push(finding(PRIVILEGED, file, line, raw));
      return;
    }
    if (/^network_mode\s*:\s*["']?(host|service:host)["']?/i.test(trimmed)) {
      push(finding(HOST_NETWORK, file, line, raw));
      return;
    }
    if (/^(pid|ipc)\s*:\s*["']?host["']?/i.test(trimmed)) {
      push(finding(HOST_PID_IPC, file, line, raw));
      return;
    }
    if (trimmed.includes('/var/run/docker.sock')) {
      push(finding(DOCKER_SOCKET, file, line, raw));
      return;
    }
    if (/^image\s*:/i.test(trimmed)) {
      const match = trimmed.match(/^image\s*:\s*(.+)$/i);
      const spec = match?.[1]?.trim().replace(/^["']|["']$/g, '');
      if (spec && !spec.startsWith('$')) {
        const parsed = parseImageRef(spec);
        if (!parsed.pinned) {
          push(finding(unpinnedImageCheck(spec), file, line, raw));
        }
      }
      return;
    }
    if (/^-\s*["']?\//.test(trimmed)) {
      const entry = trimmed.slice(1).trim();
      const source = volumeHostSource(entry);
      if (source && !source.includes('/var/run/docker.sock')) {
        const level = isBroadHostSource(source);
        if (level) {
          const check = hostMountCheck(source);
          push(finding({ ...check, severity: level }, file, line, raw));
        }
      }
      return;
    }
    const buildMatch = trimmed.match(/^(?:build\s*:|context\s*:)\s*(.+)$/i);
    if (buildMatch?.[1]) {
      const value = buildMatch[1].trim().replace(/^["']|["']$/g, '');
      if (value === '.' || value === '/' || value === '..' || value.startsWith('../')) {
        push(finding(BROAD_BUILD_CONTEXT, file, line, raw));
      }
    }
  });
}

function analyzeDockerfileLines(lines: string[], file: string, push: (diagnostic: Diagnostic) => void): void {
  lines.forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const match = trimmed.match(/^FROM\s+(.+)$/i);
    if (match?.[1]) {
      let spec = match[1].trim();
      const asSplit = spec.split(/\s+AS\s+/i);
      spec = (asSplit[0] ?? spec).trim();
      const platformSplit = spec.split(/\s+/).filter((part) => !part.startsWith('--'));
      spec = platformSplit[0] ?? spec;
      if (spec && !spec.startsWith('$') && !spec.startsWith('scratch')) {
        const parsed = parseImageRef(spec);
        if (!parsed.pinned) {
          push(finding(unpinnedImageCheck(spec), file, line, raw));
        }
      }
    }
  });
}

export const dockerSecurityDiagnosticRule: DiagnosticRule = {
  id: 'docker-security',
  name: 'Docker Security',
  category: 'container',
  severity: 'warning',

  async diagnose(context: DiagnosticContext): Promise<ReadonlyArray<Diagnostic>> {
    const diagnostics: Diagnostic[] = [];
    const push = (diagnostic: Diagnostic): void => {
      if (diagnostics.length < SECURITY_LIMITS.maxDockerFindings) {
        diagnostics.push(diagnostic);
      }
    };

    const candidates = context.workspace.allFiles
      .map((entry) => entry.relativePath)
      .filter((relativePath) => isDockerfileName(relativePath) || isComposeFileName(relativePath))
      .sort();

    for (const relativePath of candidates) {
      if (diagnostics.length >= SECURITY_LIMITS.maxDockerFindings) {
        break;
      }
      const containment = checkWorkspaceContainment(context.workspace.rootPath, relativePath);
      if (!containment.ok) {
        continue;
      }
      let stats;
      try {
        stats = await fs.lstat(containment.resolvedPath);
      } catch {
        continue;
      }
      if (!stats.isFile() || stats.size > SECURITY_LIMITS.maxDockerFileBytes) {
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(containment.resolvedPath, 'utf-8');
      } catch {
        continue;
      }
      const lines = content.split('\n');
      if (isComposeFileName(relativePath)) {
        analyzeComposeLines(lines, relativePath, push);
      } else {
        analyzeDockerfileLines(lines, relativePath, push);
      }
    }

    return diagnostics;
  },
};
