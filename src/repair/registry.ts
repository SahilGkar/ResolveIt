import type { RepairTool, RepairAction, RepairActionType, RepairToolRegistry } from '../core/models.js';

export class RepairToolRegistryImpl implements RepairToolRegistry {
  private tools: Map<string, RepairTool> = new Map();

  register(tool: RepairTool): void {
    this.tools.set(tool.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  getTool(name: string): RepairTool | undefined {
    return this.tools.get(name);
  }

  getToolsByActionType(actionType: RepairActionType): ReadonlyArray<RepairTool> {
    const results: RepairTool[] = [];
    for (const tool of this.tools.values()) {
      if (tool.supportedActionTypes.includes(actionType)) {
        results.push(tool);
      }
    }
    return results;
  }

  getAllTools(): ReadonlyArray<RepairTool> {
    return Array.from(this.tools.values());
  }

  findToolForAction(action: RepairAction): RepairTool | undefined {
    const candidates: RepairTool[] = [];
    for (const tool of this.tools.values()) {
      if (tool.supportedActionTypes.includes(action.type)) {
        candidates.push(tool);
      }
    }
    if (candidates.length === 0) {
      return undefined;
    }
    for (const tool of candidates) {
      try {
        if (tool.validate(action).valid) {
          return tool;
        }
      } catch {
        continue;
      }
    }
    return candidates[0];
  }
}

export function createRepairToolRegistry(): RepairToolRegistry {
  return new RepairToolRegistryImpl();
}