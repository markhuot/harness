// Audit rows for permission decisions (transcript status entries carrying `permission`) and the
// classifier / policy reason on an approval card.

import type { PendingApproval, PermissionDecisionLog } from "@harness/shared";
import { Icon } from "./Icon";
import "./permissions.css";

const VERB: Record<PermissionDecisionLog["decision"], (source: PermissionDecisionLog["source"]) => string> = {
  allow: (source) => (source === "classifier" ? "Auto-approved" : "Allowed"),
  ask: () => "Asked you",
  deny: () => "Denied",
};

/** "classifier · claude-cli · 2.4s" / "policy" */
export function decisionSource(log: Pick<PermissionDecisionLog, "source" | "backend" | "latencyMs">): string {
  const parts: string[] = [log.source];
  if (log.backend) parts.push(log.backend);
  if (log.latencyMs !== undefined) parts.push(`${(log.latencyMs / 1000).toFixed(1)}s`);
  return parts.join(" · ");
}

export function PermissionStatusRow({ log, time }: { log: PermissionDecisionLog; time?: string }) {
  return (
    <div className={`t-permission t-permission-${log.decision}`} data-testid="permission-row" title={`${VERB[log.decision](log.source)}: ${log.summary}\n${log.reason}\n(${decisionSource(log)}, ${log.mode} mode)`}>
      <Icon name="shield" size={11} />
      <span className="t-permission-verb">{VERB[log.decision](log.source)}</span>
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
