// A ticket's settings rows (Model, Permissions, Agent review, Branch, Base branch, Depends on),
// the same component in a ticket's Details tab and in a draft's Options (views/DraftEditor.tsx).
// It only asks for changes (`onPatch`, an UpdateTicketBody): Details sends them to the service, a
// draft editor applies them locally and saves them on its own schedule. Which rows show, and which
// can change, is ticketSettingsRows's call (@harness/shared/state).

import { useEffect, useState, type ReactNode } from "react";
import type { BranchInfo, Project, Ticket, UpdateTicketBody } from "@harness/shared";
import { isTicketKey, plannedBranch, resolveBaseBranch, resolvePermissionMode } from "@harness/shared";
import {
  checkoutBranch,
  depChipTitle,
  dependencyStates,
  draftBranchPatch,
  draftBranchPick,
  draftBranchValue,
  draftDefaultBranchLabel,
  inheritedBaseLabel,
  inheritedModel,
  newTicketBranchLabel,
  ticketBranchHint,
  ticketChoice,
  ticketChoicePatch,
  ticketResolvedChoice,
  ticketSettingsRows,
} from "@harness/shared/state";
import { useStore } from "../state/store";
import { skipReviewHint } from "../state/newSession";
import { DriverModelSelect } from "./ModelSelect";
import { PermissionModeSelect } from "./PermissionModeSelect";
import { BranchSelect } from "./BranchSelect";
import { StatusDot, Switch } from "./bits";
import { Icon } from "./Icon";
import { useOpenTicket, usePaneScope } from "./paneContext";
import { openTicket as openTicketPane, updatePanes } from "../state/panes";

const BRANCH_LIMIT = 200;

/**
 * The project's local branches (enough to find the one the project directory has checked out),
 * plus `name` when the list doesn't reach it, so its hint can tell whether it's checked out
 * elsewhere. Empty off git.
 */
export function useProjectBranches(project: Pick<Project, "id" | "isGit"> | null | undefined, name: string | null): BranchInfo[] {
  const { client, epoch } = useStore();
  const id = project && project.isGit !== false ? project.id : null;
  const [list, setList] = useState<{ id: string; branches: BranchInfo[] } | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    client.projectBranches(id, "", BRANCH_LIMIT).then(
      (branches) => live && setList({ id, branches }),
      () => live && setList({ id, branches: [] }),
    );
    return () => {
      live = false;
    };
  }, [client, id, epoch]);
  const branches = list && list.id === id ? list.branches : [];
  const [extra, setExtra] = useState<BranchInfo | null>(null);
  const missing = !!id && !!name && !!list && list.id === id && !branches.some((b) => b.name === name);
  useEffect(() => {
    if (!missing || !id || !name) return;
    let live = true;
    client.projectBranches(id, name, 5).then(
      (found) => live && setExtra(found.find((b) => b.name === name) ?? null),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, id, name, missing]);
  return missing && extra?.name === name ? [...branches, extra] : branches;
}

/** The project directory's own branch, from the project's branch list (null off git, or while loading). */
export const useCheckoutBranch = (project: Project | null | undefined, branches: readonly BranchInfo[]) => (project ? checkoutBranch(branches, project.path) : null);

export function TicketSettings({
  ticket,
  project,
  onPatch,
  children,
}: {
  ticket: Ticket;
  project: Project | undefined;
  onPatch: (patch: UpdateTicketBody) => void;
  /** More rows after these, in the same list (Details' read-only rows) */
  children?: ReactNode;
}) {
  const { state } = useStore();
  const rows = ticketSettingsRows(ticket, project);
  const { editable } = rows;
  const draft = !!ticket.draft;
  const branches = useProjectBranches(project, ticket.requestedBranch ?? null);
  const checkout = useCheckoutBranch(project, branches);
  const inheritedBase = resolveBaseBranch(null, project, state.settings);
  const base = resolveBaseBranch(ticket, project, state.settings);
  // What the Branch pick will do: shown while it can still change.
  const hint = project && rows.branch.show && rows.branch.editable ? ticketBranchHint(ticket, project, state.settings, branches, checkout) : null;
  const warn = !!hint && hint.tone !== "plain";

  return (
    <dl className="props ticket-settings" data-testid="ticket-settings">
      <dt>Model</dt>
      <dd title={draft ? undefined : ticket.busy ? "Applies from the next run. The driver can't change while a run is going." : "Applies from the next run"}>
        <DriverModelSelect
          value={ticketChoice(ticket, project, state.settings)}
          resolved={ticketResolvedChoice(project, state.settings)}
          disabled={!editable}
          onlyDriver={rows.onlyDriver}
          inheritedModel={(d) => inheritedModel(d, "ticket", project, state.settings)}
          onChange={(c) => onPatch(ticketChoicePatch(c, project, state.settings))}
        />
      </dd>
      <dt>Permissions</dt>
      <dd title={draft ? undefined : "Applies from the next tool call"}>
        <PermissionModeSelect
          value={ticket.permissionMode}
          disabled={!editable}
          inherited={resolvePermissionMode(null, project, state.settings ?? { permissionMode: "auto" }).mode}
          onChange={(m) => onPatch({ permissionMode: m })}
        />
      </dd>
      <dt>Agent review</dt>
      <dd title={editable ? skipReviewHint(ticket) : undefined}>
        <Switch checked={!!ticket.skipAgentReview} disabled={!editable} onChange={(v) => onPatch({ skipAgentReview: v })} label="Skip agent review" />
      </dd>
      {rows.branch.show && project && (
        <>
          <dt>Branch</dt>
          {draft ? (
            <dd title="The branch the ticket works on. The project directory's own branch means no worktree.">
              <BranchSelect
                projectId={project.id}
                value={draftBranchValue(ticket, project, checkout)}
                disabled={!editable}
                onChange={(name) => onPatch(draftBranchPatch(draftBranchPick(name, checkout), project))}
                defaultLabel={draftDefaultBranchLabel(ticket.key, project, checkout)}
                newLabel={(name) => `Create ${name} from ${base.branch}`}
              />
            </dd>
          ) : rows.branch.editable ? (
            <dd title="The branch the ticket's worktree checks out when work starts">
              <BranchSelect
                projectId={project.id}
                value={ticket.requestedBranch ?? null}
                onChange={(v) => onPatch({ branch: v })}
                defaultLabel={newTicketBranchLabel(ticket.key)}
                newLabel={(name) => `Create ${name} from ${base.branch}`}
              />
            </dd>
          ) : (
            // Read-only once the worktree exists (or the ticket is done), so no "when work starts" note.
            <dd className="mono selectable">{plannedBranch(ticket)}</dd>
          )}
        </>
      )}
      {rows.base.show && project && (
        <>
          <dt>Base branch</dt>
          {rows.base.editable ? (
            <dd title="What the ticket's work merges into when it completes. Applies from the next run.">
              <BranchSelect
                label="Base branch"
                projectId={project.id}
                value={ticket.baseBranch ?? null}
                onChange={(v) => onPatch({ baseBranch: v })}
                defaultLabel={inheritedBaseLabel(inheritedBase)}
                newLabel={(name) => `Use ${name}`}
              />
            </dd>
          ) : (
            <dd className="mono selectable">
              {base.branch}
              {base.source !== "ticket" && <span className="muted"> · inherited</span>}
            </dd>
          )}
        </>
      )}
      {hint && (
        <dd className={`field-hint branch-hint ${warn ? "warn" : ""} ${hint.tone === "error" ? "error" : ""}`} data-testid="branch-hint" data-tone={hint.tone}>
          {warn && <Icon name="alert" size={11} />}
          {hint.text}
        </dd>
      )}
      <DependsOn ticket={ticket} editable={editable} onPatch={onPatch} />
      {children}
    </dl>
  );
}

/** The Depends on row: ticket keys, saved on blur (or Enter), with a chip per dependency. */
function DependsOn({ ticket, editable, onPatch }: { ticket: Ticket; editable: boolean; onPatch: (patch: UpdateTicketBody) => void }) {
  const { state } = useStore();
  const scope = usePaneScope();
  const openHere = useOpenTicket();
  // A draft's pane keeps the draft: a dependency opens beside it instead.
  const openTicket = ticket.draft ? (key: string) => updatePanes(scope, (s) => openTicketPane(s, key)) : openHere;
  const [deps, setDeps] = useState(ticket.dependsOn.join(", "));
  // Follow changes from elsewhere unless the user is mid-edit.
  useEffect(() => {
    setDeps(ticket.dependsOn.join(", "));
  }, [ticket.dependsOn.join(",")]);
  const parsed = deps
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const bad = parsed.filter((d) => !isTicketKey(d));
  const dirty = parsed.join(",") !== ticket.dependsOn.join(",");
  const save = () => {
    if (!dirty || bad.length) return;
    onPatch({ dependsOn: parsed });
  };
  const depStates = dependencyStates(state, ticket);
  return (
    <>
      <dt>Depends on</dt>
      <dd className="deps-row">
        <input
          className="input mono"
          aria-label="Depends on"
          data-testid="depends-on"
          placeholder="e.g. NYTIMES-3, NYTIMES-4"
          value={deps}
          disabled={!editable}
          onChange={(e) => setDeps(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
        {bad.length > 0 ? (
          <span className="field-hint" style={{ color: "var(--red)" }}>
            Not a ticket key: {bad.join(", ")}
          </span>
        ) : (
          depStates.length > 0 && (
            <div className="row" style={{ flexWrap: "wrap", gap: 6 }}>
              {depStates.map((d) => (
                <button key={d.key} className={`chip link-chip ${d.state}`} data-dep-state={d.state} title={depChipTitle(d)} onClick={() => d.ticket && openTicket(d.ticket.key)} disabled={!d.ticket}>
                  {d.ticket && <StatusDot status={d.ticket.status} />}
                  {d.ticket?.key ?? d.key}
                </button>
              ))}
            </div>
          )
        )}
      </dd>
    </>
  );
}
