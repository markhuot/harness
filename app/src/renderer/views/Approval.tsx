// Tool-permission request from the agent (claude-code driver): the ticket is blocked until a
// human allows once, allows the tool for the whole ticket, or denies.

import { useState } from "react";
import type { PendingApproval, Ticket } from "@harness/shared";
import { useAction, useStore } from "../state/store";
import { Icon } from "../components/Icon";
import { relativeTime, useNow } from "../components/bits";
import { ApprovalReason } from "../components/PermissionLog";

type Shown = { label: string; value: string; code: boolean };

/** Pick the part of a tool input a human needs to judge the request. */
export function describeApprovalInput(toolName: string, input: unknown): { primary: Shown | null; description: string | null; rest: Record<string, unknown> | null } {
  const o = input && typeof input === "object" && !Array.isArray(input) ? { ...(input as Record<string, unknown>) } : null;
  if (!o) return { primary: input === undefined || input === null ? null : { label: "Input", value: JSON.stringify(input, null, 2), code: true }, description: null, rest: null };
  const take = (k: string) => {
    const v = o[k];
    delete o[k];
    return typeof v === "string" ? v : null;
  };
  const description = take("description");
  const tool = toolName.replace(/^mcp__[^_]+__/, "");
  let primary: Shown | null = null;
  const pick = (k: string, label: string, code: boolean) => {
    if (primary || typeof o[k] !== "string") return;
    primary = { label, value: take(k)!, code };
  };
  if (/^bash$/i.test(tool)) pick("command", "Command", true);
  if (/^(write|edit|multiedit|read|notebookedit)$/i.test(tool)) {
    pick("file_path", "File", true);
    pick("notebook_path", "File", true);
  }
  if (/^(webfetch|websearch)$/i.test(tool)) {
    pick("url", "URL", false);
    pick("query", "Query", false);
  }
  pick("command", "Command", true);
  pick("url", "URL", false);
  pick("file_path", "File", true);
  pick("path", "Path", true);
  return { primary, description, rest: Object.keys(o).length ? o : null };
}

export function ApprovalCard({ ticket, approval }: { ticket: Ticket; approval: PendingApproval }) {
  const { client } = useStore();
  const act = useAction();
  const now = useNow(10_000);
  const [denying, setDenying] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const tool = approval.toolName.replace(/^mcp__[^_]+__/, "");
  const { primary, description, rest } = describeApprovalInput(approval.toolName, approval.input);

  const answer = async (decision: "allow_once" | "allow_tool" | "deny") => {
    setBusy(decision);
    await act(
      () => client.answerApproval(ticket.key, { decision, message: message.trim() || undefined }),
      decision === "deny" ? `Denied ${tool}` : decision === "allow_tool" ? `${tool} allowed on ${ticket.key}` : `Allowed ${tool} once`,
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
            {description ?? "Approve to let this run continue."} · requested {relativeTime(approval.requestedAt, now)}
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
            <button className="btn" onClick={() => answer("allow_tool")} disabled={!!busy} title={`Every future ${tool} call on ${ticket.key} runs without asking`}>
              {busy === "allow_tool" ? <span className="spinner" /> : <Icon name="checkCircle" />} Always allow {tool} on this ticket
            </button>
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
