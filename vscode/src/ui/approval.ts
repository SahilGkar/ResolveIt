import * as vscode from 'vscode';
import type { PlannedManualAction, RepairPlan } from '../../../src/index.js';
export interface ApprovalDialogs {
  showPlanMessage(message: string): Promise<void>;
  askAction(description: string, permissionLevel: string): Promise<boolean>;
}

export function vscodeApprovalDialogs(): ApprovalDialogs {
  return {
    showPlanMessage: (message: string): Promise<void> => {
      void vscode.window.showInformationMessage(message);
      return Promise.resolve();
    },
    askAction: (description: string, permissionLevel: string): Promise<boolean> => {
      return Promise.resolve(
        vscode.window.showQuickPick(['Allow', 'Deny'], {
          placeHolder: `${description} (${permissionLevel})`,
          ignoreFocusOut: true,
        })
      ).then((choice) => choice === 'Allow');
    },
  };
}

export async function requestPlanApproval(
  plan: RepairPlan,
  manualActions: ReadonlyArray<PlannedManualAction>,
  dialogs: ApprovalDialogs,
  notify: (message: string) => void
): Promise<ReadonlyArray<string>> {
  if (manualActions.length > 0) {
    notify(
      `Manual action required: ${manualActions.map((manual) => manual.description).join('; ')}`
    );
  }

  if (plan.actions.length === 0) {
    return [];
  }

  await dialogs.showPlanMessage(
    `ResolveIt wants to make ${plan.actions.length} project change${plan.actions.length === 1 ? '' : 's'}. Review each action.`
  );

  const approved: string[] = [];
  for (const action of plan.actions) {
    const allowed = await dialogs.askAction(action.description, action.permissionLevel);
    if (allowed) {
      approved.push(action.id);
    }
  }
  return approved;
}
