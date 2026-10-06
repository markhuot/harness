// Tool-permission request from the agent (claude-code driver): the ticket is blocked until a
// human allows once, allows the tool for the whole ticket, or denies.

import { useState } from "react";
import { keyLabel, type PendingApproval, type Ticket } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { Icon } from "../components/Icon";
import { relativeTime, useNow } from "../components/bits";
import { ApprovalReason } from "../components/PermissionLog";
import { approvalToast, describeApprovalInput, shownToolCall, type ShownInput } from "@harness/shared/state";

type Shown = ShownInput;

export { describeApprovalInput } from "@harness/shared/state";

export function ApprovalCard({ ticket, approval }: { ticket: Ticket; approval: PendingApproval }) {
  const { client } = useStore();
  const act = useAction();
  const now = useNow(10_000);
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const tool = shownToolCall(approval.toolName, approval.input).name;
  const { primary, description, rest } = describeApprovalInput(approval.toolName, approval.input);

  const answer = async (decision: "allow_once" | "allow_tool" | "deny") => {
    setBusy(decision);
    await act(
      () => client.answerApproval(ticket.key, { decision, message: message.trim() || undefined }),
      approvalToast(decision, tool, keyLabel(ticket)),
    );
    setBusy(null);
  };

  return (
    <div className="approval" role="alert">
      <div className="approval-head">
        <span className="approval-icon">
          <Icon name="lock" size={15} />
        </span>
        <div className="grow">
          <div className="approval-title">
            The agent wants to use <code>{tool}</code>
          </div>
          <div className="muted approval-sub">
            {approval.summary ?? description ?? "Approve to let this run continue."} · requested {relativeTime(approval.requestedAt, now)}
          </div>
        </div>
      </div>
      <ApprovalReason approval={approval} />
      {primary && (
        <div className="approval-input">
          <div className="t-label">{(primary as Shown).label}</div>
          {(primary as Shown).code ? (
            <pre className="selectable">{(primary as Shown).value}</pre>
          ) : (
            <div className="approval-url selectable mono">{(primary as Shown).value}</div>
          )}
        </div>
      )}
      {rest && (
        <details className="approval-more">
          <summary>{primary ? "Other input" : "Input"}</summary>
          <pre className="selectable">{JSON.stringify(rest, null, 2)}</pre>
        </details>
      )}
      {denying && (
        <textarea
          autoFocus
          className="textarea"
          rows={2}
          placeholder="Optional: tell the agent why, or what to do instead"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void answer("deny")}
        />
      )}
      <div className="approval-actions">
        {denying ? (
          <>
            <button className="btn btn-ghost" onClick={() => setDenying(false)} disabled={!!busy}>
              Back
            </button>
            <div className="grow" />
            <button className="btn btn-danger-solid" onClick={() => answer("deny")} disabled={!!busy}>
              {busy === "deny" ? <span className="spinner" /> : <Icon name="x" strokeWidth={2.25} />} Deny
            </button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" onClick={() => answer("allow_once")} disabled={!!busy}>
              {busy === "allow_once" ? <span className="spinner" /> : <Icon name="check" strokeWidth={2.25} />} Allow once
            </button>
            {!approval.onceOnly && (
              <button className="btn" onClick={() => answer("allow_tool")} disabled={!!busy} title={`Every future ${tool} call on ${keyLabel(ticket)} runs without asking`}>
                {busy === "allow_tool" ? <span className="spinner" /> : <Icon name="checkCircle" />} Always allow {tool} on this ticket
              </button>
            )}
            <div className="grow" />
            <button className="btn btn-ghost btn-danger" onClick={() => setDenying(true)} disabled={!!busy}>
              Deny…
            </button>
          </>
        )}
      </div>
    </div>
  );
}
