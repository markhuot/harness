// Audit rows for permission decisions (transcript status entries carrying `permission`) and the
// classifier / policy reason on an approval card.

import type { PendingApproval, PermissionDecisionLog } from "@harness/shared";
import { decisionSource, permissionVerb } from "@harness/shared/state";
import { Icon } from "./Icon";

export { decisionSource } from "@harness/shared/state";
import "./permissions.css";



export function PermissionStatusRow({ log, time }: { log: PermissionDecisionLog; time?: string }) {
  return (
    <div className={`t-permission t-permission-${log.decision}`} data-testid="permission-row" title={`${permissionVerb(log)}: ${log.summary}\n${log.reason}\n(${decisionSource(log)}, ${log.mode} mode)`}>
      <Icon name="shield" size={11} />
      <span className="t-permission-verb">{permissionVerb(log)}</span>
      <code className="t-permission-what">{log.summary}</code>
      <span className="t-permission-reason">{log.reason}</span>
      <span className="t-permission-source">{decisionSource(log)}</span>
      {time && <span className="t-time">{time}</span>}
    </div>
  );
}

/** Why the human is being asked, when the service said (classifier judgement or policy). */
export function ApprovalReason({ approval }: { approval: PendingApproval }) {
  if (!approval.reason) return null;
  return (
    <div className={`approval-reason approval-reason-${approval.source ?? "policy"}`} data-testid="approval-reason">
      <Icon name="shield" size={12} />
      <span>
        <strong>{approval.source === "classifier" ? "Auto-mode classifier" : "Permission policy"}:</strong> {approval.reason}
      </span>
    </div>
  );
}
