import type { WorkspaceManager, Workspace, Project, WorkspaceWatcher, WorkspaceChangeCallback } from '../core/interfaces.js';
import { scanWorkspace } from '../scanners/index.js';

export class WorkspaceManagerImpl implements WorkspaceManager {
  private workspace: Workspace | null = null;
  
  async discoverWorkspace(rootPath: string): Promise<Workspace> {
    this.workspace = await scanWorkspace(rootPath);
    return this.workspace;
  }
  
  getProject(projectId: string): Project | undefined {
    return this.workspace?.projects.find(p => p.id === projectId);
  }
  
  getProjects(): ReadonlyArray<Project> {
    return this.workspace?.projects || [];
  }
  
  getEnvironments(): ReadonlyArray<Workspace['environments'][0]> {
    return this.workspace?.environments || [];
  }
  
  watchWorkspace(_callback: WorkspaceChangeCallback): WorkspaceWatcher {
    return {
      dispose(): void {
      },
    };
  }
}

export function createWorkspaceManager(): WorkspaceManager {
  return new WorkspaceManagerImpl();
}