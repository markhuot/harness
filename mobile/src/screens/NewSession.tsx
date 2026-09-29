// New session: project, prompt, Task/Conductor, driver + model (one picker), permission mode, Start immediately, Use worktree.
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { DEFAULT_TRIAGE_CHOICE, resolvePermissionMode, type PermissionMode, type TicketKind, type TriageChoice } from "@harness/shared";
import { composerProject, inheritedModel, newSessionPlaceholder, sortedProjects } from "@harness/shared/state";
import { useApp, useColors } from "../state/app";
import { useAction, useStore } from "../state/store";
import { Button, ProjectKey, Segmented } from "../ui/kit";
import { KeyboardAvoider } from "../ui/KeyboardAvoider";
import { PermissionPicker, Select } from "../ui/selects";
import { DriverModelPicker } from "../ui/DriverModelPicker";
import { haptic } from "../ui/haptics";
import { buttonItem, primaryItemStyle } from "../ui/header";
import { MentionList, useFileMentions } from "../ui/mentions";

export function NewSessionScreen() {
  const params = useLocalSearchParams<{ projectId?: string }>();
  const { state, client } = useStore();
  const { prefs, setPref } = useApp();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const projects = sortedProjects(state);
  const [chosen, setChosen] = useState(params.projectId ?? "");
  const projectId = composerProject(state, chosen, [prefs.boardProject, prefs.lastProject]);
  const project = state.projects[projectId];
  const [prompt, setPrompt] = useState("");
  const searchFiles = useCallback((q: string) => (projectId ? client.projectFiles(projectId, q) : Promise.resolve([])), [client, projectId]);
  const mentions = useFileMentions(prompt, setPrompt, searchFiles);
  const [start, setStart] = useState(true);
  const [kind, setKind] = useState<TicketKind>("task");
  const defaultDriver = project?.defaultDriver ?? state.settings?.defaultDriver ?? state.drivers[0]?.id ?? "";
  // Driver + model from the combined picker; Default follows the project (so it tracks a project switch).
  const [choice, setChoice] = useState<TriageChoice>(DEFAULT_TRIAGE_CHOICE);
  const resolved = { driver: defaultDriver || null, model: defaultDriver ? inheritedModel(defaultDriver, "ticket", project, state.settings) : null };
  // Follows the project's worktree setting until flipped; only shown for git projects.
  const projectWorktrees = project?.useWorktrees ?? true;
  const [worktree, setWorktree] = useState(projectWorktrees);
  const touchedWorktree = useRef(false);
  useEffect(() => {
    if (!touchedWorktree.current) setWorktree(projectWorktrees);
  }, [projectWorktrees]);
  const canWorktree = project?.isGit !== false;
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(null);
  const inheritedMode = resolvePermissionMode(null, project, state.settings ?? { permissionMode: "auto" }).mode;
  const [busy, setBusy] = useState(false);
  const canSubmit = !!prompt.trim() && !!projectId && !busy;

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    const useWorktree = canWorktree ? worktree : null;
    const t = await act(() => client.createTicket({ projectId, prompt: prompt.trim(), start, kind, driver: choice.driver ?? (defaultDriver || undefined), model: choice.model, permissionMode, useWorktree }));
    setBusy(false);
    if (!t) return;
    haptic("success");
    setPref("lastProject", projectId);
    router.dismiss();
    router.push({ pathname: "/ticket/[key]", params: { key: t.key, tab: start ? "transcript" : "summaries" } });
  };

  const addProject = () =>
    Alert.prompt("Add project", "The folder's absolute path on the Mac, e.g. /Users/you/Sites/app", async (path) => {
      if (!path?.trim()) return;
      const p = await act(() => client.createProject({ path: path.trim() }), "Project added");
      if (p) setChosen(p.id);
    });

  return (
    <KeyboardAvoider style={{ flex: 1, backgroundColor: c.bg }}>
      <Stack.Screen
        options={{
          title: "New session",
          unstable_headerLeftItems: () => [buttonItem("Cancel", "xmark", () => router.dismiss())],
          unstable_headerRightItems: () => [buttonItem(start ? "Start" : "Plan", start ? "paperplane.fill" : "list.bullet.clipboard", () => void submit(), { ...primaryItemStyle(c), disabled: !canSubmit })],
        }}
      />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 14 }} keyboardShouldPersistTaps="handled">
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {project && <ProjectKey k={project.key} color={project.color} />}
          <Select
            value={projectId}
            options={projects.map((p) => ({ value: p.id, label: `${p.name} (${p.key})` }))}
            onChange={setChosen}
            placeholder={projects.length ? "Choose a project" : "Add a project"}
            title="Project"
            accessibilityName="Project"
            actions={[{ label: "Add a project…", systemImage: "folder.badge.plus", onPress: addProject }]}
          />
        </View>
        <TextInput
          autoFocus
          multiline
          value={prompt}
          onChangeText={setPrompt}
          placeholder={newSessionPlaceholder(kind, start)}
          placeholderTextColor={c.text3}
          style={{ minHeight: 170, textAlignVertical: "top", borderRadius: 12, borderWidth: 1, borderColor: c.border, backgroundColor: c.bgElev, color: c.text, padding: 13, fontSize: 17, lineHeight: 23 }}
          accessibilityLabel="Prompt"
          {...mentions.inputProps}
        />
        <MentionList mentions={mentions} />
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "task", label: "Task" },
            { value: "conductor", label: "Conductor" },
          ]}
        />
        {kind === "conductor" && <Text style={{ color: c.text3, fontSize: 13 }}>Orchestrates child tickets.</Text>}
        <View style={{ gap: 10 }}>
          <Line label="Model">
            <DriverModelPicker value={choice} resolved={resolved} onChange={setChoice} />
          </Line>
          <Line label="Permissions">
            <PermissionPicker value={permissionMode} inherited={inheritedMode} onChange={setPermissionMode} />
          </Line>
          <Line label="Start immediately">
            <Switch value={start} onValueChange={setStart} trackColor={{ true: c.accent }} />
          </Line>
          {canWorktree && (
            <Line label="Use worktree">
              <Switch
                value={worktree}
                onValueChange={(v) => {
                  touchedWorktree.current = true;
                  setWorktree(v);
                }}
                trackColor={{ true: c.accent }}
              />
            </Line>
          )}
        </View>
        <Button title={start ? "Start session" : "Plan first"} variant="primary" icon={start ? "play" : "fileText"} onPress={() => void submit()} disabled={!canSubmit} loading={busy} hapticKind={null} />
      </ScrollView>
    </KeyboardAvoider>
  );
}

function Line({ label, children }: { label: string; children: React.ReactNode }) {
  const c = useColors();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 10, minHeight: 40 }}>
      <Text style={{ color: c.text2, fontSize: 15 }}>{label}</Text>
      {children}
    </View>
  );
}
