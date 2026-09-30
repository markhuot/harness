// New session edits a draft ticket (DESIGN.md "Drafts"): the project with Task | Conductor, the
// prompt, and an Options disclosure holding the same TicketSettings rows as ticket Details. The
// draft is saved lazily (lib/draftSync): nothing until it has something worth keeping, then a POST
// and debounced PATCHes. Start session / Plan first launch it; Cancel asks whether to save or
// discard a non-empty draft, and a swipe down saves it. `?key=` reopens a saved draft (a draft
// card on the board, or /ticket/<key> for one).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { DEFAULT_TRIAGE_CHOICE, type Ticket, type TicketKind, type UpdateTicketBody } from "@harness/shared";
import {
  applyTicketPatch,
  blankDraftTicket,
  composerProject,
  driverLabel,
  newSessionOptionsSummary,
  newSessionPlaceholder,
  optionsNeedAttention,
  predictedTicketKey,
  sortedProjects,
  ticketByKey,
  ticketChoice,
  ticketChoicePatch,
} from "@harness/shared/state";
import { useApp, useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { Button, Card, Empty, ProjectKey, Segmented, Spinner } from "../ui/kit";
import { KeyboardAvoider } from "../ui/KeyboardAvoider";
import { Select } from "../ui/selects";
import { haptic } from "../ui/haptics";
import { buttonItem, primaryItemStyle } from "../ui/header";
import { MentionList, useFileMentions } from "../ui/mentions";
import { Icon } from "../ui/Icon";
import { pick } from "../ui/pick";
import { TicketSettings, useTicketBranches } from "../ui/TicketSettings";
import { DraftSync } from "../lib/draftSync";

export function NewSessionScreen() {
  const params = useLocalSearchParams<{ projectId?: string; key?: string }>();
  const reopen = params.key ? String(params.key) : null;
  const { state, client, dispatch, watchKey, toast } = useStore();
  const { prefs, setPref } = useApp();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const stateRef = useRef(state);
  stateRef.current = state;
  const projects = sortedProjects(state);

  // Reopening a draft: keep its key resolved while the store may not have it yet.
  useEffect(() => (reopen ? watchKey(reopen) : undefined), [reopen, watchKey]);

  const [local, setLocal] = useState<Ticket | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const syncRef = useRef<DraftSync | null>(null);
  const seen = useRef(false);
  const submitting = useRef(false);
  const initialProjectId = composerProject(state, params.projectId ?? "", [prefs.boardProject, prefs.lastProject]);
  const stored = reopen ? ticketByKey(state, reopen) : undefined;
  const taken = useCallback((k: string) => !!ticketByKey(stateRef.current, k), []);

  // Start the editor once the store has what it needs: the reopened draft, or a project.
  useEffect(() => {
    if (syncRef.current) return;
    let start: Ticket;
    if (reopen) {
      if (!stored) return;
      if (!stored.draft) {
        router.replace({ pathname: "/ticket/[key]", params: { key: stored.key } });
        return;
      }
      start = stored;
    } else {
      const p = state.projects[initialProjectId];
      if (!p) return;
      start = blankDraftTicket(p, state.settings, predictedTicketKey(p, taken));
    }
    syncRef.current = new DraftSync({
      api: {
        create: (body) => client.createTicket(body),
        update: (key, patch) => client.updateTicket(key, patch),
        remove: (key) => client.deleteTicket(key),
        submit: (key, start) => client.submitTicket(key, { start }),
      },
      local: start,
      saved: reopen ? start : null,
      project: (id) => stateRef.current.projects[id],
      settings: () => stateRef.current.settings,
      onChange: setLocal,
      onSaved: (t) => {
        dispatch({ type: "tickets", tickets: [t] });
        setSavedId(t.id);
      },
      onError: (e) => {
        haptic("error");
        toast(`Couldn't save the draft: ${e instanceof Error ? e.message : String(e)}`, "error");
      },
    });
    if (reopen) setSavedId(start.id);
    setLocal(start);
  }, [reopen, stored, state.projects, state.settings, initialProjectId, client, dispatch, toast, router, taken]);

  // Swiping the sheet down (or any other way the screen goes) saves the draft.
  useEffect(
    () => () => {
      const s = syncRef.current;
      if (s && !s.isClosed) s.close().catch(() => {});
    },
    [],
  );

  // The store's copy of the saved draft: another device's edit, launch or discard.
  const storeTicket = savedId ? state.tickets[savedId] : undefined;
  useEffect(() => {
    const s = syncRef.current;
    if (!s || !savedId || submitting.current || s.isClosed) return;
    if (!storeTicket) {
      if (seen.current && state.ready) {
        s.dispose();
        toast("This draft was discarded on another device.", "info");
        router.dismiss();
      }
      return;
    }
    seen.current = true;
    if (!storeTicket.draft) {
      s.dispose();
      router.dismiss();
      router.push({ pathname: "/ticket/[key]", params: { key: storeTicket.key } });
      return;
    }
    s.incoming(storeTicket);
  }, [storeTicket, savedId, state.ready, toast, router]);

  const project = local ? state.projects[local.projectId] : undefined;
  // Until it's saved, the key shown (harness/<key>) is the project's next one.
  const view = useMemo(() => (local && project && !savedId ? { ...local, key: predictedTicketKey(project, taken) } : local), [local, project, savedId, taken, state.tickets]); // eslint-disable-line react-hooks/exhaustive-deps
  const branches = useTicketBranches(view);
  const hint = branches.hint;

  const edit = useCallback((next: Ticket) => {
    const s = syncRef.current;
    if (!s) return;
    s.edit(next);
    setLocal(s.local);
  }, []);
  const patch = useCallback((p: UpdateTicketBody) => syncRef.current && edit(applyTicketPatch(syncRef.current.local, p)), [edit]);
  const setPrompt = useCallback((description: string) => patch({ description }), [patch]);
  const searchFiles = useCallback((q: string) => (local?.projectId ? client.projectFiles(local.projectId, q) : Promise.resolve([])), [client, local?.projectId]);
  // The commands of the agent this session will run with, so switching drivers switches the list.
  const commandDriver = local && project ? ticketChoice(local, project, state.settings).driver : null;
  const searchCommands = useCallback(
    (q: string) => (local?.projectId ? client.projectCommands(local.projectId, q, { driver: commandDriver }) : Promise.resolve([])),
    [client, local?.projectId, commandDriver],
  );
  const mentions = useFileMentions(local?.description ?? "", setPrompt, searchFiles, searchCommands);

  // Options start collapsed, and open by themselves when the branch pick needs a look.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const attention = !!hint && optionsNeedAttention(hint);
  useEffect(() => {
    if (attention) setOptionsOpen(true);
  }, [attention]);

  const changeProject = (id: string) => {
    const s = syncRef.current;
    const next = state.projects[id];
    if (!s || !next || id === s.local.projectId) return;
    const p: UpdateTicketBody = { projectId: id, branch: null, baseBranch: null, useWorktree: null };
    // A Default model keeps following the project it's in.
    if (ticketChoice(s.local, project, state.settings).driver === null) Object.assign(p, ticketChoicePatch(DEFAULT_TRIAGE_CHOICE, next, state.settings));
    patch(p);
  };

  const [busy, setBusy] = useState<"start" | "plan" | null>(null);
  const canSubmit = !!local?.description.trim() && !!project && !busy && hint?.tone !== "error";
  const submit = async (start: boolean) => {
    const s = syncRef.current;
    if (!canSubmit || !s) return;
    setBusy(start ? "start" : "plan");
    submitting.current = true;
    const t = await act(() => s.submit(start));
    setBusy(null);
    if (!t) {
      submitting.current = false;
      return;
    }
    haptic("success");
    dispatch({ type: "tickets", tickets: [t] });
    setPref("lastProject", t.projectId);
    router.dismiss();
    router.push({ pathname: "/ticket/[key]", params: { key: t.key, tab: start ? "transcript" : "summaries" } });
  };

  const cancel = async () => {
    const s = syncRef.current;
    if (!s) return router.dismiss();
    if (s.empty) {
      void act(() => s.discard());
      return router.dismiss();
    }
    const choice = await pick<"save" | "discard">({
      choices: [
        { value: "save", label: "Save draft" },
        { value: "discard", label: "Discard draft", destructive: true },
      ],
      cancelLabel: "Keep editing",
    });
    if (choice === "save") void act(() => s.close());
    else if (choice === "discard") void act(() => s.discard());
    else return;
    router.dismiss();
  };

  const addProject = () =>
    Alert.prompt("Add project", "The folder's absolute path on the Mac, e.g. /Users/you/Sites/app", async (path) => {
      if (!path?.trim()) return;
      const p = await act(() => client.createProject({ path: path.trim() }), "Project added");
      if (p) changeProject(p.id);
    });

  const summary = view && project ? newSessionOptionsSummary(view, project, state.settings, { driver: (id) => driverLabel(id, state.drivers), checkoutName: branches.checkout?.name }) : [];
  const kind = local?.kind ?? "task";

  return (
    <KeyboardAvoider style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          title: reopen ? "Draft" : "New session",
          unstable_headerLeftItems: () => [buttonItem("Cancel", "xmark", () => void cancel())],
          unstable_headerRightItems: () => [buttonItem("Start", "paperplane.fill", () => void submit(true), { ...primaryItemStyle(c), disabled: !canSubmit })],
        }}
      />
      {!view ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          {reopen && !stored && state.missingKeys[reopen.toUpperCase()] ? (
            <Empty icon="alert" title={`${reopen} not found`}>
              It may have been discarded.
            </Empty>
          ) : state.ready && !projects.length ? (
            <Empty icon="folder" title="No projects yet" action={<Button title="Add a project" variant="primary" icon="plus" onPress={addProject} />}>
              Add the folder a session should work in.
            </Empty>
          ) : (
            <Spinner />
          )}
        </View>
      ) : (
        <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            {project && <ProjectKey k={project.key} color={project.color} />}
            <View style={{ flex: 1, alignItems: "flex-start" }}>
              <Select
                value={view.projectId}
                options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.key})` }))}
                onChange={changeProject}
                placeholder={projects.length ? "Choose a project" : "Add a project"}
                title="Project"
                accessibilityName="Project"
                actions={[{ label: "Add a project…", systemImage: "folder.badge.plus", onPress: addProject }]}
              />
            </View>
            <Segmented<TicketKind>
              value={kind}
              onChange={(k) => patch({ kind: k })}
              style={{ width: 190 }}
              options={[
                { value: "task", label: "Task" },
                { value: "conductor", label: "Conductor" },
              ]}
            />
          </View>
          <TextInput
            autoFocus={!reopen}
            multiline
            value={view.description}
            onChangeText={setPrompt}
            placeholder={newSessionPlaceholder(kind)}
            placeholderTextColor={c.text3}
            style={{ minHeight: 170, textAlignVertical: "top", borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bgElev, color: c.text, padding: 13, fontSize: 17, lineHeight: 23 }}
            accessibilityLabel="Prompt"
            {...mentions.inputProps}
          />
          <MentionList mentions={mentions} />
          {kind === "conductor" && <Text style={{ color: c.text3, fontSize: 13 }}>Orchestrates child tickets.</Text>}
          <View style={{ gap: 10 }}>
            <Pressable
              onPress={() => {
                haptic("select");
                setOptionsOpen((o) => !o);
              }}
              accessibilityRole="button"
              accessibilityState={{ expanded: optionsOpen }}
              accessibilityLabel={summary.length ? `Options, ${summary.join(", ")}` : "Options"}
              hitSlop={6}
              style={({ pressed }) => ({ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 36, opacity: pressed ? 0.6 : 1 })}
            >
              <Icon name={optionsOpen ? "chevronDown" : "chevronRight"} size={15} color={attention ? c.amber : c.text2} strokeWidth={2.25} />
              <Text numberOfLines={1} style={{ flex: 1, color: summary.length ? c.text : c.text2, fontSize: 15 }}>
                {summary.length ? summary.join(" · ") : "Options"}
              </Text>
            </Pressable>
            {optionsOpen && (
              <Card>
                <TicketSettings ticket={view} onPatch={patch} branches={branches} last />
              </Card>
            )}
          </View>
          <View style={{ gap: 8 }}>
            <Button title="Start session" variant="primary" icon="play" onPress={() => void submit(true)} disabled={!canSubmit} loading={busy === "start"} hapticKind={null} />
            <Button title="Plan first" variant="ghost" icon="fileText" onPress={() => void submit(false)} disabled={!canSubmit} loading={busy === "plan"} hapticKind={null} />
          </View>
        </ScrollView>
      )}
    </KeyboardAvoider>
  );
}
