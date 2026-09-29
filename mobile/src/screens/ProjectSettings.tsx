// Project settings: name, identifier (rename with the desktop's live validation + preview), color,
// folder path (a text field: there's no folder picker on the phone), default driver / models /
// permission mode, worktrees, base branch and "When approved" (git projects), human review, remove.
import { useEffect, useMemo, useState } from "react";
import { ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import type { Project } from "@harness/shared";
import { inheritedBaseLabel, inheritedModel, previewProjectKey, projectChoice, projectChoicePatch } from "@harness/shared/state";
import { branchNameError, DEFAULT_TRIAGE_CHOICE, offeredCompletionActions, PERMISSION_MODE_LABELS, projectCompletionDefault, resolveBaseBranch } from "@harness/shared";
import { useApp, useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { MONO } from "../theme/tokens";
import { Button, Empty, ProjectKey } from "../ui/kit";
import { ProjectColorPicker } from "../ui/ProjectColor";
import { Icon } from "../ui/Icon";
import { DraftField, Group, SRow, SSwitch, useInputStyle } from "../ui/settings";
import { PermissionPicker, Select } from "../ui/selects";
import { DriverModelPicker } from "../ui/DriverModelPicker";
import { completionActionOptions } from "../lib/approve";
import { confirm } from "../ui/pick";

export function ProjectSettingsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { state } = useStore();
  const c = useColors();
  const project = state.projects[String(id)];
  if (!project)
    return (
      <View style={{ flex: 1, backgroundColor: c.bg }}>
        <Empty icon="folder" title="This project no longer exists" />
      </View>
    );
  return <ProjectSettings key={project.id} project={project} />;
}

function ProjectSettings({ project }: { project: Project }) {
  const { state, client, toast } = useStore();
  const { prefs, setPref } = useApp();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const inputStyle = useInputStyle();
  const save = (body: Parameters<typeof client.updateProject>[1], ok?: string) => act(() => client.updateProject(project.id, body), ok);
  // Done tickets page in, so the count for "Remove project" asks the service for its done total.
  const [doneTotal, setDoneTotal] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    client
      .ticketPage({ status: "done", projectId: project.id, limit: 1 })
      .then((p) => live && setDoneTotal(p.total))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [client, project.id]);
  const loaded = Object.values(state.tickets).filter((t) => t.projectId === project.id);
  const ticketCount = loaded.filter((t) => t.status !== "done").length + (doneTotal ?? loaded.filter((t) => t.status === "done").length);
  const [path, setPath] = useState(project.path);
  useEffect(() => setPath(project.path), [project.path]);

  const remove = async () => {
    const n = ticketCount;
    const what = n ? `its ${n} ticket${n === 1 ? "" : "s"} and their transcripts` : "the project";
    if (!(await confirm(`Remove ${project.name} (${project.key})?`, `This deletes ${what}. Files on disk, branches and worktrees are left alone.`, "Remove"))) return;
    const ok = await act(() => client.deleteProject(project.id), "Project removed");
    if (ok) {
      if (prefs.boardProject === project.id) setPref("boardProject", null);
      router.back();
    }
  };
  const savePath = async () => {
    const p = path.trim();
    if (!p || p === project.path) return setPath(project.path);
    if (!(await confirm("Change the project folder?", `Agents start new runs in ${p}.`, "Change", false))) return setPath(project.path);
    await save({ path: p }, "Project folder updated");
  };
  const inherited = state.settings?.permissionMode ?? "auto";

  return (
    <ScrollView style={{ backgroundColor: c.bg }} contentContainerStyle={{ padding: 16, gap: 22, paddingBottom: 60 }} keyboardShouldPersistTaps="handled" automaticallyAdjustKeyboardInsets>
      <Stack.Screen options={{ title: project.name }} />
      <Group title="General">
        <SRow title="Name">
          <DraftField value={project.name} onCommit={(v) => v.trim() && void save({ name: v.trim() })} />
        </SRow>
        <KeyRow project={project} />
        <SRow title={<View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}><Text style={{ color: c.text, fontSize: 16 }}>Color</Text><ProjectKey k={project.key} color={project.color} /></View>} sub="Tints the project's key badge on cards, tickets and lists." stacked>
          <ProjectColorPicker value={project.color} onChange={(color) => void save({ color })} />
        </SRow>
        <SRow title="Folder" sub="Absolute path on the Mac" stacked last>
          <TextInput style={[inputStyle, { fontFamily: MONO, fontSize: 14 }]} value={path} onChangeText={setPath} onBlur={() => void savePath()} onSubmitEditing={() => void savePath()} autoCapitalize="none" autoCorrect={false} returnKeyType="done" />
        </SRow>
      </Group>
      <Group title="Agents">
        <SRow title="Default model" sub="Used for new sessions in this project. Global default follows the app setting.">
          <DriverModelPicker
            value={projectChoice(project, state.settings)}
            resolved={state.settings ? { driver: state.settings.defaultDriver, model: inheritedModel(state.settings.defaultDriver, "project", project, state.settings) } : DEFAULT_TRIAGE_CHOICE}
            defaultLabel="Global default"
            inheritedModel={(d) => inheritedModel(d, "project", project, state.settings)}
            onChange={(choice) => void save(projectChoicePatch(choice, project))}
            title="Default model"
          />
        </SRow>
        <SRow title="Permission mode" sub={`${PERMISSION_MODE_LABELS[project.permissionMode ?? inherited].description} Tickets can override it.`}>
          <PermissionPicker value={project.permissionMode} inherited={inherited} onChange={(m) => void save({ permissionMode: m })} />
        </SRow>
        <SRow title="Worktree per ticket" sub="Each ticket works on its own branch (harness/<key>) when the folder is a git repo.">
          <SSwitch label="Worktree per ticket" value={project.useWorktrees} onChange={(v) => void save({ useWorktrees: v })} />
        </SRow>
        {project.isGit && (
          <SRow title="Base branch" sub="Tickets merge into it when they complete, and new branches start from it. Empty follows the app setting.">
            <DraftField
              value={project.baseBranch ?? ""}
              mono
              placeholder={inheritedBaseLabel(resolveBaseBranch(null, null, state.settings))}
              autoCapitalize="none"
              autoCorrect={false}
              accessibilityLabel="Base branch"
              onCommit={(v) => {
                const name = v.trim();
                const error = name ? branchNameError(name) : null;
                if (error) toast(`Not a valid branch name: ${error}`, "error");
                else void save({ baseBranch: name || null });
              }}
            />
          </SRow>
        )}
        <SRow title="Require human review" sub="When off, the agent reviewer alone can clear a ticket for completion.">
          <SSwitch label="Require human review" value={project.requireHumanReview} onChange={(v) => void save({ requireHumanReview: v })} />
        </SRow>
        <SRow title="Complete when approved" sub="Once both reviews approve, run the completion step (merge the branch, clean up) and move the ticket to Done." last={!project.isGit}>
          <SSwitch label="Complete when approved" value={project.autoComplete} onChange={(v) => void save({ autoComplete: v })} />
        </SRow>
        {project.isGit && (
          <SRow title="When approved" sub="What the Approve button does by default: merge the branch, open a pull request, or follow instructions you give. Each approval can pick another." last>
            <Select
              value={projectCompletionDefault(project)}
              options={completionActionOptions(offeredCompletionActions(project))}
              onChange={(completionAction) => void save({ completionAction })}
              title="When approved"
              accessibilityName="When approved"
            />
          </SRow>
        )}
      </Group>
      <Group title="Danger zone">
        <SRow title="Remove project" sub={`Deletes ${ticketCount ? `${ticketCount} ticket${ticketCount === 1 ? "" : "s"} and their history` : "the project"} from Harness. Files on disk are left alone.`} stacked last>
          <Button title="Remove project…" icon="trash" variant="dangerSolid" onPress={() => void remove()} hapticKind="warning" />
        </SRow>
      </Group>
    </ScrollView>
  );
}

/** Identifier (ticket key prefix) with live validation and a rename preview. */
function KeyRow({ project }: { project: Project }) {
  const { state, client } = useStore();
  const act = useAction();
  const c = useColors();
  const inputStyle = useInputStyle();
  const [draft, setDraft] = useState(project.key);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(project.key), [project.key]);
  const preview = useMemo(() => previewProjectKey(project, Object.values(state.projects), Object.values(state.tickets), draft), [project, state.projects, state.tickets, draft]);
  const commit = async () => {
    if (!preview.changed || preview.error || busy) return;
    setBusy(true);
    const n = preview.renames.length;
    await act(() => client.updateProject(project.id, { key: preview.key }), `Renamed to ${preview.key}${n ? ` · ${n} ticket${n === 1 ? "" : "s"} renumbered` : ""}`);
    setBusy(false);
  };
  const color = preview.error ? c.red : preview.changed ? c.amber : c.text3;
  return (
    <SRow title="Identifier" stacked>
      <View style={{ gap: 8 }}>
        <TextInput
          style={[inputStyle, { fontFamily: MONO, borderColor: preview.error ? c.red : c.border }]}
          value={draft}
          maxLength={20}
          autoCapitalize="characters"
          autoCorrect={false}
          onChangeText={(v) => setDraft(v.toUpperCase())}
          onSubmitEditing={() => void commit()}
          accessibilityLabel="Identifier"
        />
        <View style={{ flexDirection: "row", gap: 6, alignItems: "flex-start" }}>
          {preview.error && <Icon name="alert" size={13} color={c.red} />}
          <Text style={{ color, fontSize: 13, flex: 1, lineHeight: 18 }}>{preview.message}</Text>
        </View>
        {preview.changed && (
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button small title="Cancel" variant="ghost" onPress={() => setDraft(project.key)} disabled={busy} />
            <Button small title="Rename" variant="primary" onPress={() => void commit()} disabled={!!preview.error} loading={busy} />
          </View>
        )}
      </View>
    </SRow>
  );
}
