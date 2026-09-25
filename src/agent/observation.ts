import type { EnvironmentInfo, ParsedRequirements, Workspace } from '../core/interfaces.js';
import { scanWorkspace } from '../scanners/index.js';
import { scanEnvironment } from '../environment/index.js';
import { scanRequirements } from '../requirements/index.js';

export interface AgentObservation {
  readonly workspace: Workspace;
  readonly environment: EnvironmentInfo;
  readonly requirements: ReadonlyArray<ParsedRequirements>;
  readonly timestamp: Date;
}

export async function observeWorkspace(workspaceRoot: string, timeout = 60000): Promise<AgentObservation> {
  const [workspace, environment, requirements] = await Promise.all([
    scanWorkspace(workspaceRoot, { maxDepth: 50, maxFiles: 100000 }),
    scanEnvironment({ timeout }),
    scanRequirements(workspaceRoot, { timeout }),
  ]);

  return { workspace, environment, requirements, timestamp: new Date() };
}
