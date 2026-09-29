// A ticket's settings rows, the same for a launched ticket (the Details tab) and a draft (New
// session's Options): Model, Permissions, Skip agent review, Branch (with the hint under it), Base
// branch and Depends on. Which rows show and which can change come from the shared
// ticketSettingsRows; every change goes out as one UpdateTicketBody through `onPatch` (a PATCH for a
// launched ticket, applyTicketPatch on a draft's local state). The rows render bare, so the caller
// puts them in its own Card (Details follows them with its read-only rows).

import { useEffect, useMemo, useState } from "react";
import { Switch, Text, TextInput, View } from "react-native";
import { useRouter } from "expo-router";
import { isTicketKey, plannedBranch, resolveBaseBranch, resolvePermissionMode, type BranchInfo, type Project, type Ticket, type UpdateTicketBody } from "@harness/shared";
import {
  checkoutBranch,
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
import { useColors } from "../state/app";
import { useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { skipReviewHint } from "../lib/newSession";
import { BranchPicker } from "./BranchPicker";
import { DriverModelPicker } from "./DriverModelPicker";
import { Chip } from "./kit";
import { Prop } from "./Prop";
import { PermissionPicker } from "./selects";

export type BranchHint = { text: string; tone: "plain" | "warn" | "error" };

/**
 * What the branch rows need from the project's branch list: the branch the project directory has
 * checked out (a draft's "no worktree" pick), the branches the hint can classify against, and the
 * hint itself. New session reads the hint to open Options when it needs attention.
 */
export function useTicketBranches(ticket: Ticket | null) {
  const { state, client, epoch } = useStore();
  const project = ticket ? state.projects[ticket.projectId] : undefined;
  const projectId = project?.isGit === false ? "" : (project?.id ?? "");
  const [list, setList] = useState<BranchInfo[]>([]);
  // The branch picked in the sheet comes with its entry, which the list may not reach (it's capped).
  const [picked, setPicked] = useState<BranchInfo[]>([]);
  useEffect(() => {
    setList([]);
    setPicked([]);
    if (!projectId) return;
    let live = true;
    client.projectBranches(projectId).then(
      (l) => live && setList(l),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, projectId, epoch]);
  const requested = ticket?.requestedBranch ?? null;
  const listed = !requested || list.some((b) => b.name === requested) || picked.some((b) => b.name === requested);
  useEffect(() => {
    if (!projectId || listed || !requested) return;
    let live = true;
    client.projectBranches(projectId, requested).then(
      (l) => live && setPicked((p) => [...p, ...l.filter((b) => b.name === requested)]),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [client, projectId, requested, listed]);
  const known = useMemo(() => [...picked, ...list], [picked, list]);
  const checkout = project ? checkoutBranch(list, project.path) : null;
  const hint: BranchHint | null = ticket && project ? ticketBranchHint(ticket, project, state.settings, known, checkout) : null;
  const remember = (b: BranchInfo | null) => b && setPicked((p) => [b, ...p.filter((x) => x.name !== b.name)]);
  return { project, checkout, known, hint, remember };
}

export type TicketBranches = ReturnType<typeof useTicketBranches>;

/** `last`: the rows end the card (no divider under Depends on). */
export function TicketSettings({ ticket, onPatch, branches: given, last }: { ticket: Ticket; onPatch: (patch: UpdateTicketBody) => void; branches?: TicketBranches; last?: boolean }) {
  const { state } = useStore();
  const c = useColors();
  const own = useTicketBranches(given ? null : ticket);
  const branches = given ?? own;
  const project = state.projects[ticket.projectId];
  const rows = ticketSettingsRows(ticket, project);
  const draft = !!ticket.draft;
  const base = resolveBaseBranch(ticket, project, state.settings).branch;
  const inheritedBase = resolveBaseBranch(null, project, state.settings);
  const hint = branches.hint;
  const hintColor = hint?.tone === "warn" ? c.amber : hint?.tone === "error" ? c.red : c.text3;

  return (
    <>
      <Prop label="Model" hint={draft ? undefined : ticket.busy ? "Applies from the next run. The driver can't change while a run is going." : "Applies from the next run"}>
        <DriverModelPicker
          value={ticketChoice(ticket, project, state.settings)}
          resolved={ticketResolvedChoice(project, state.settings)}
          disabled={!rows.editable}
          onlyDriver={rows.onlyDriver}
          inheritedModel={(d) => inheritedModel(d, "ticket", project, state.settings)}
          onChange={(choice) => onPatch(ticketChoicePatch(choice, project, state.settings))}
        />
      </Prop>
      <Prop label="Permissions" hint={draft ? undefined : "Applies from the next tool call"}>
        <PermissionPicker value={ticket.permissionMode} disabled={!rows.editable} inherited={resolvePermissionMode(null, project, state.settings ?? { permissionMode: "auto" }).mode} onChange={(m) => onPatch({ permissionMode: m })} />
      </Prop>
      <Prop label="Skip agent review" hint={rows.editable ? skipReviewHint(ticket) : undefined}>
        <Switch value={!!ticket.skipAgentReview} disabled={!rows.editable} onValueChange={(v) => onPatch({ skipAgentReview: v })} trackColor={{ true: c.accent }} accessibilityLabel="Skip agent review" />
      </Prop>
      {rows.branch.show && project && (
        <Prop
          label="Branch"
          hint={draft ? undefined : rows.branch.editable ? "Until work starts" : ticket.branch ? undefined : "When work starts"}
          footer={rows.branch.editable && hint ? <Text style={{ color: hintColor, fontSize: 13, lineHeight: 18 }}>{hint.text}</Text> : undefined}
        >
          {rows.branch.editable ? (
            draft ? (
              <BranchPicker
                projectId={project.id}
                value={draftBranchValue(ticket, project, branches.checkout)}
                defaultLabel={draftDefaultBranchLabel(ticket.key, project, branches.checkout)}
                newLabel={(name) => `Create ${name} from ${base}`}
                onChange={(name, info) => {
                  branches.remember(info);
                  onPatch(draftBranchPatch(draftBranchPick(name, branches.checkout), project));
                }}
              />
            ) : (
              <BranchPicker
                projectId={project.id}
                value={ticket.requestedBranch ?? null}
                defaultLabel={newTicketBranchLabel(ticket.key)}
                newLabel={(name) => `Create ${name} from ${base}`}
                onChange={(name, info) => {
                  branches.remember(info);
                  onPatch({ branch: name });
                }}
              />
            )
          ) : (
            <Text selectable style={{ fontFamily: MONO, fontSize: 12.5, color: c.text }}>
              {plannedBranch(ticket)}
            </Text>
          )}
        </Prop>
      )}
      {rows.base.show && project && (
        <Prop label="Base branch" hint={draft ? undefined : ticket.baseBranch ? "Applies from the next run" : "Inherited"}>
          {rows.base.editable ? (
            <BranchPicker
              title="Base branch"
              projectId={project.id}
              value={ticket.baseBranch ?? null}
              defaultLabel={inheritedBaseLabel(inheritedBase)}
              newLabel={(name) => `Merge into ${name}`}
              onChange={(name) => onPatch({ baseBranch: name })}
            />
          ) : (
            <Text selectable style={{ fontFamily: MONO, fontSize: 12.5, color: ticket.baseBranch ? c.text : c.text3 }}>
              {ticket.baseBranch || inheritedBaseLabel(inheritedBase)}
            </Text>
          )}
        </Prop>
      )}
      <DependsOnProp ticket={ticket} project={project} editable={rows.editable} onPatch={onPatch} last={last} />
    </>
  );
}

/** Depends on: ticket keys typed comma- or space-separated, saved on blur / return; chips open them. */
function DependsOnProp({ ticket, project, editable, onPatch, last }: { ticket: Ticket; project: Project | undefined; editable: boolean; onPatch: (patch: UpdateTicketBody) => void; last?: boolean }) {
  const { state } = useStore();
  const c = useColors();
  const router = useRouter();
  const [text, setText] = useState(ticket.dependsOn.join(", "));
  const depKey = ticket.dependsOn.join(",");
  useEffect(() => setText(ticket.dependsOn.join(", ")), [depKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const parsed = text
    .split(/[\s,]+/)
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const bad = parsed.filter((d) => !isTicketKey(d));
  const save = () => {
    if (bad.length || parsed.join(",") === depKey) return;
    onPatch({ dependsOn: parsed });
  };
  const deps = dependencyStates(state, ticket);
  const footer =
    bad.length > 0 ? (
      <Text style={{ color: c.red, fontSize: 13 }}>Not a ticket key: {bad.join(", ")}</Text>
    ) : deps.length > 0 ? (
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
        {deps.map((d) => (
          <Chip key={d.key} label={d.key} done={d.done} unknown={d.state === "unknown"} onPress={d.missing ? undefined : () => router.push({ pathname: "/ticket/[key]", params: { key: d.ticket?.key ?? d.key } })} />
        ))}
      </View>
    ) : undefined;
  return (
    <Prop label="Depends on" footer={footer} last={last}>
      {editable ? (
        <TextInput
          value={text}
          onChangeText={setText}
          onBlur={save}
          onSubmitEditing={save}
          returnKeyType="done"
          autoCapitalize="characters"
          autoCorrect={false}
          placeholder={`e.g. ${project?.key ?? "WEB"}-3, ${project?.key ?? "WEB"}-4`}
          placeholderTextColor={c.text3}
          accessibilityLabel="Depends on"
          style={{ color: c.text, fontSize: 13.5, fontFamily: MONO, textAlign: "right", minWidth: 160, flexShrink: 1, paddingVertical: 4 }}
        />
      ) : (
        <Text selectable style={{ fontFamily: MONO, fontSize: 13.5, color: ticket.dependsOn.length ? c.text : c.text3 }}>
          {ticket.dependsOn.join(", ") || "None"}
        </Text>
      )}
    </Prop>
  );
}
