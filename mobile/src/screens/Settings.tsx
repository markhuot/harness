// Settings: connection (saved servers, token rotation), network, appearance, drivers + login,
// general, models, permissions, watchers, mappings, projects.
import { useCallback, useEffect, useState } from "react";
import { Alert, Linking, Pressable, RefreshControl, ScrollView, Text, TextInput, View } from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as WebBrowser from "expo-web-browser";
import { CLASSIFIER_BACKENDS, LISTEN_MODES, PERMISSION_MODE_LABELS, type ClassifierBackend, type DriverInfo, type ListenMode, type NetworkStatus, type PublicSettings } from "@harness/shared";
import { CLASSIFIER_LABELS, inheritedModel, relativeTime, sortedProjects, tildify } from "@harness/shared/state";
import { useApp, useColors, useTheme } from "../state/app";
import { useAction, useStore } from "../state/store";
import { displayHost } from "../lib/pair";
import { MONO } from "../theme/tokens";
import { Badge, Button, ProjectKey, Segmented, Spinner } from "../ui/kit";
import { Icon } from "../ui/Icon";
import { DraftField, Group, SRow, SSwitch, useInputStyle } from "../ui/settings";
import { ModelPicker, PermissionPicker, PickerButton } from "../ui/selects";
import { confirm, pick } from "../ui/pick";
import { ConnectionBanner } from "./ConnectionBanner";
import { ThemeSwatch } from "../ui/ThemeSwatch";
import { pickerCaption, themeLinkPrefs, themeOptions, themePrefKey } from "../lib/themePicker";
import type { Prefs } from "../lib/prefs";

export function SettingsScreen() {
  const { state, refresh } = useStore();
  const c = useColors();
  const [refreshing, setRefreshing] = useState(false);
  return (
    <ScrollView
      style={{ backgroundColor: c.bg }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ padding: 16, gap: 24, paddingBottom: 120 }}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustKeyboardInsets
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await refresh();
            setRefreshing(false);
          }}
        />
      }
    >
      <Stack.Screen options={{ title: "Settings", headerLargeTitle: true }} />
      <ConnectionBanner />
      <ConnectionSection />
      <NetworkSection />
      <AppearanceSection />
      <DriversSection />
      {state.settings && <GeneralSection settings={state.settings} />}
      {state.settings && <ModelsSection settings={state.settings} />}
      {state.settings && <PermissionsSection settings={state.settings} />}
      <WatchersSection />
      <MappingsSection />
      <ProjectsSection />
    </ScrollView>
  );
}

// ---------------------------------------------------------------------------

function ConnectionSection() {
  const { servers, active, activate, forget, rename, pair } = useApp();
  const { state, client, baseUrl } = useStore();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const serverMenu = async (id: string) => {
    const s = servers.find((x) => x.id === id)!;
    const v = await pick({
      title: s.name,
      message: s.baseUrl,
      choices: [...(active?.id !== id ? [{ value: "use", label: "Connect" }] : []), { value: "rename", label: "Rename…" }, { value: "forget", label: "Forget this Mac", destructive: true }],
    });
    if (v === "use") void activate(id);
    if (v === "rename") Alert.prompt("Rename", undefined, (name) => rename(id, name ?? ""), "plain-text", s.name);
    if (v === "forget" && (await confirm(`Forget ${s.name}?`, "Its token is removed from this iPhone.", "Forget"))) void forget(id);
  };
  const rotate = async () => {
    if (!(await confirm("Rotate the token?", "Every client using the current token is disconnected, including the desktop app until it reconnects. This iPhone switches to the new token.", "Rotate"))) return;
    const res = await act(() => client.rotateToken(), "Token rotated");
    if (res) await pair({ baseUrl, token: res.token }, { skipProbe: true });
  };
  return (
    <Group title="Connection" footer="Pair another Mac by scanning the QR code in Harness → Settings → Network on that Mac.">
      {servers.map((s) => (
        <SRow
          key={s.id}
          onPress={() => void serverMenu(s.id)}
          title={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {active?.id === s.id && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: state.connected ? c.green : c.amber }} />}
              <Text style={{ color: c.text, fontSize: 16 }}>{s.name}</Text>
            </View>
          }
          sub={s.name !== displayHost(s.baseUrl) ? <Text style={{ color: c.text3, fontSize: 12.5, fontFamily: MONO }}>{displayHost(s.baseUrl)}</Text> : undefined}
        >
          {active?.id === s.id ? <Badge tone={state.connected ? "green" : "amber"}>{state.connected ? "Connected" : "Reconnecting"}</Badge> : <Icon name="chevronRight" size={14} color={c.text3} />}
        </SRow>
      ))}
      <SRow title={<Text style={{ color: c.accent, fontSize: 16 }}>Pair a Mac…</Text>} onPress={() => router.push("/connect")} />
      <SRow title={<Text style={{ color: c.red, fontSize: 16 }}>Rotate token…</Text>} sub="Invalidates the current token for every client." onPress={() => void rotate()} last />
    </Group>
  );
}

const LISTEN_LABEL: Record<ListenMode, string> = { localhost: "This Mac only", tailscale: "Tailscale", any: "All networks", custom: "Custom address" };

function NetworkSection() {
  const { client, epoch, state } = useStore();
  const act = useAction();
  const c = useColors();
  const [net, setNet] = useState<NetworkStatus | null>(null);
  const load = useCallback(() => {
    client
      .network()
      .then(setNet)
      .catch(() => setNet(null));
  }, [client]);
  useEffect(load, [load, epoch, state.settings?.listen?.mode]);
  if (!net) return null;
  const change = async () => {
    const v = await pick<ListenMode>({ title: "Listen on", selected: net.mode, choices: LISTEN_MODES.filter((m) => m !== "custom").map((m) => ({ value: m, label: LISTEN_LABEL[m] })) });
    if (!v || v === net.mode) return;
    if (v === "localhost" && !(await confirm("Listen on this Mac only?", "This iPhone will lose its connection until you change it back on the Mac.", "Change"))) return;
    await act(() => client.updateSettings({ listen: { mode: v } } as never), "Network updated");
    setTimeout(load, 800);
  };
  return (
    <Group title="Network" footer={net.override ? `HARNESS_HOST=${net.override} overrides this setting.` : "Where the service accepts connections. The phone needs Tailscale or All networks."}>
      <SRow title="Listen on" sub={net.error ?? undefined}>
        <PickerButton label={net.mode === "custom" ? `Custom · ${net.host ?? ""}` : LISTEN_LABEL[net.mode]} onPress={() => void change()} disabled={!!net.override} />
      </SRow>
      <SRow title="Addresses" last={!net.tailscale}>
        <View style={{ alignItems: "flex-end" }}>
          {net.bound.map((b) => (
            <Text key={b.url} selectable style={{ fontFamily: MONO, fontSize: 12.5, color: c.text2 }}>
              {b.url.replace(/^https?:\/\//, "")}
            </Text>
          ))}
        </View>
      </SRow>
      {net.tailscale && (
        <SRow title="Tailscale" last>
          <View style={{ alignItems: "flex-end" }}>
            <Text selectable style={{ fontFamily: MONO, fontSize: 12.5, color: c.text2 }}>
              {net.tailscale.ip}
            </Text>
            {net.tailscale.dnsName && (
              <Text selectable style={{ fontFamily: MONO, fontSize: 11.5, color: c.text3 }}>
                {net.tailscale.dnsName}
              </Text>
            )}
          </View>
        </SRow>
      )}
    </Group>
  );
}

function AppearanceSection() {
  const { prefs, setPref } = useApp();
  const t = useTheme();
  // harness://settings?lightTheme=…&darkTheme=…&theme=… applies a shared theme setup.
  const params = useLocalSearchParams<{ lightTheme?: string; darkTheme?: string; theme?: string }>();
  const link = JSON.stringify(themeLinkPrefs(params));
  useEffect(() => {
    for (const [k, v] of Object.entries(JSON.parse(link) as Partial<Prefs>)) setPref(k as keyof Prefs, v as never);
  }, [link, setPref]);
  // Appearance.setColorScheme pins useColorScheme to an explicit choice, so the OS side is only
  // known under System; the pickers only consult it then.
  const systemDark = t.preference === "system" && t.resolved === "dark";
  return (
    <>
      <Group title="Appearance" footer={t.preference === "system" ? `Follows iOS (currently ${t.resolved}).` : "Stays the same regardless of the iOS setting."}>
        <SRow title="Theme" stacked last>
          <Segmented
            value={t.preference}
            onChange={(v) => setPref("theme", v)}
            options={[
              { value: "system", label: "System" },
              { value: "light", label: "Light" },
              { value: "dark", label: "Dark" },
            ]}
          />
        </SRow>
      </Group>
      {(["light", "dark"] as const).map((appearance) => (
        <ThemePicker key={appearance} appearance={appearance} prefs={prefs} systemDark={systemDark} onPick={(id) => setPref(themePrefKey(appearance), id)} />
      ))}
    </>
  );
}

function ThemePicker({ appearance, prefs, systemDark, onPick }: { appearance: "light" | "dark"; prefs: Prefs; systemDark: boolean; onPick: (id: string) => void }) {
  const options = themeOptions(appearance, prefs, systemDark);
  // Open scrolled so the picked theme is in view (swatches are 104pt wide with a 10pt gap).
  const picked = Math.max(0, options.findIndex((o) => o.selected));
  return (
    <Group title={appearance === "light" ? "Light theme" : "Dark theme"} footer={pickerCaption(appearance, prefs, systemDark)}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentOffset={{ x: Math.max(0, picked * 114 - 114), y: 0 }}
        contentContainerStyle={{ padding: 12, gap: 10 }}
        accessibilityRole="radiogroup"
        accessibilityLabel={appearance === "light" ? "Light theme" : "Dark theme"}
      >
        {options.map((o) => (
          <ThemeSwatch key={o.theme.id} theme={o.theme} selected={o.selected} onPress={() => onPick(o.theme.id)} />
        ))}
      </ScrollView>
    </Group>
  );
}

function driverStatus(d: DriverInfo) {
  if (!d.available) return <Badge tone="red">Unavailable</Badge>;
  if (!d.authenticated) return <Badge tone="amber">Not signed in</Badge>;
  return (
    <Badge tone="green" icon="check">
      Ready
    </Badge>
  );
}

function DriversSection() {
  const { state, client, dispatch, epoch, toast } = useStore();
  const act = useAction();
  const c = useColors();
  const [loading, setLoading] = useState(false);
  const reload = useCallback(async () => {
    setLoading(true);
    const drivers = await act(() => client.listDrivers());
    if (drivers) dispatch({ type: "drivers", drivers });
    setLoading(false);
  }, [act, client, dispatch]);
  useEffect(() => {
    if (epoch > 0) void reload();
  }, [epoch]); // eslint-disable-line react-hooks/exhaustive-deps
  const login = async (d: DriverInfo) => {
    const res = await act(() => client.loginDriver(d.id));
    if (!res) return;
    if (res.url) await WebBrowser.openBrowserAsync(res.url).catch(() => Linking.openURL(res.url!));
    if (res.message) toast(res.message, "info");
  };
  return (
    <Group
      title="Drivers"
      right={
        <Pressable onPress={() => void reload()} hitSlop={8} accessibilityRole="button" accessibilityLabel="Refresh drivers">
          {loading ? <Spinner /> : <Icon name="refresh" size={15} color={c.accent} />}
        </Pressable>
      }
    >
      {state.drivers.length === 0 && <SRow title="No drivers reported by the service." last />}
      {state.drivers.map((d, i) => (
        <SRow
          key={d.id}
          last={i === state.drivers.length - 1}
          title={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
              <Text style={{ color: c.text, fontSize: 16 }}>{d.name}</Text>
              {driverStatus(d)}
              {state.settings?.defaultDriver === d.id && <Badge tone="accent">Default</Badge>}
            </View>
          }
          sub={[d.description, d.detail].filter(Boolean).join("\n")}
        >
          {d.supportsLogin && <Button small title={d.authenticated ? "Log in again" : "Log in"} icon="key" onPress={() => void login(d)} />}
        </SRow>
      ))}
    </Group>
  );
}

function GeneralSection({ settings }: { settings: PublicSettings }) {
  const { state, client } = useStore();
  const act = useAction();
  const c = useColors();
  const inputStyle = useInputStyle();
  const [apiKey, setApiKey] = useState("");
  const [replacing, setReplacing] = useState(false);
  const save = (body: Parameters<typeof client.updateSettings>[0]) => act(() => client.updateSettings(body));
  const chooseDriver = async () => {
    const v = await pick({ title: "Default driver", selected: settings.defaultDriver, choices: state.drivers.map((d) => ({ value: d.id, label: d.name })) });
    if (v) void save({ defaultDriver: v });
  };
  const saveKey = async () => {
    if (!apiKey.trim()) return;
    const ok = await act(() => client.updateSettings({ anthropicApiKey: apiKey.trim() }), "API key saved");
    if (ok) {
      setApiKey("");
      setReplacing(false);
    }
  };
  return (
    <Group title="General">
      <SRow title="Default driver" sub="Used for new sessions unless the project overrides it.">
        <PickerButton label={state.drivers.find((d) => d.id === settings.defaultDriver)?.name ?? settings.defaultDriver} onPress={() => void chooseDriver()} />
      </SRow>
      <SRow title="Max concurrent runs" sub="Agent runs across all sessions. Extra runs wait in the queue.">
        <DraftField
          value={String(settings.maxConcurrentRuns)}
          keyboardType="number-pad"
          onCommit={(v) => {
            const n = Math.round(Number(v));
            if (Number.isFinite(n)) void save({ maxConcurrentRuns: Math.min(32, Math.max(1, n)) });
          }}
        />
      </SRow>
      <SRow title="Anthropic API key" sub="Stored by the service; falls back to ANTHROPIC_API_KEY." stacked last>
        {settings.anthropicApiKeySet && !replacing ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Icon name="checkCircle" size={15} color={c.green} />
            <Text style={{ color: c.green, flex: 1, fontSize: 15 }}>Key saved</Text>
            <Button small title="Replace" onPress={() => setReplacing(true)} />
            <Button small title="Clear" variant="danger" onPress={() => void act(() => client.updateSettings({ anthropicApiKey: null }), "API key cleared")} />
          </View>
        ) : (
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput style={[inputStyle, { flex: 1, fontFamily: MONO, fontSize: 14 }]} secureTextEntry placeholder="sk-ant-…" placeholderTextColor={c.text3} value={apiKey} onChangeText={setApiKey} autoCapitalize="none" autoCorrect={false} onSubmitEditing={() => void saveKey()} />
            <Button title="Save" variant="primary" disabled={!apiKey.trim()} onPress={() => void saveKey()} />
            {replacing && <Button title="Cancel" variant="ghost" onPress={() => setReplacing(false)} />}
          </View>
        )}
      </SRow>
    </Group>
  );
}

function ModelsSection({ settings }: { settings: PublicSettings }) {
  const { state, client } = useStore();
  const act = useAction();
  const c = useColors();
  const saveMap = (field: "defaultModels" | "reviewModels", driver: string, model: string | null) => void act(() => client.updateSettings({ [field]: { [driver]: model } }));
  return (
    <Group title="Models" footer="Tickets and projects can pick their own model; these apply when they don't.">
      {state.drivers.map((d, i) => (
        <SRow key={d.id} title={d.name} stacked last={i === state.drivers.length - 1}>
          <View style={{ gap: 8 }}>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <Text style={{ color: c.text2, fontSize: 14 }}>Default</Text>
              <ModelPicker driver={d.id} value={settings.defaultModels[d.id] ?? null} inherited={inheritedModel(d.id, "settings", null, settings)} onChange={(m) => saveMap("defaultModels", d.id, m)} />
            </View>
            <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
              <Text style={{ color: c.text2, fontSize: 14 }}>Agent review</Text>
              <ModelPicker driver={d.id} value={settings.reviewModels[d.id] ?? null} defaultLabel="Same as work" plainDefault onChange={(m) => saveMap("reviewModels", d.id, m)} title="Review model" />
            </View>
          </View>
        </SRow>
      ))}
    </Group>
  );
}

function PermissionsSection({ settings }: { settings: PublicSettings }) {
  const { client } = useStore();
  const act = useAction();
  const chooseClassifier = async () => {
    const v = await pick<ClassifierBackend>({ title: "Auto-mode classifier", selected: settings.classifier, choices: CLASSIFIER_BACKENDS.map((b) => ({ value: b, label: CLASSIFIER_LABELS[b] })) });
    if (v) void act(() => client.updateSettings({ classifier: v }));
  };
  return (
    <Group title="Permissions" footer="How much agents may do without asking. Projects and tickets can override the mode. Plan runs are always read-only.">
      <SRow title="Default mode" sub={PERMISSION_MODE_LABELS[settings.permissionMode].description}>
        <PermissionPicker value={settings.permissionMode} onChange={(m) => m && void act(() => client.updateSettings({ permissionMode: m }))} />
      </SRow>
      <SRow title="Auto-mode classifier" sub="Judges actions in auto mode for the Anthropic API and Dummy drivers. Claude Code tickets use Claude Code's own classifier." last>
        <PickerButton label={CLASSIFIER_LABELS[settings.classifier]} onPress={() => void chooseClassifier()} />
      </SRow>
    </Group>
  );
}

function WatchersSection() {
  const { state, client } = useStore();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const watchers = Object.values(state.watchers).sort((a, b) => a.name.localeCompare(b.name));
  const driverName = (id: string | null) => (id ? (state.drivers.find((d) => d.id === id)?.name ?? id) : "Default driver");
  const menu = async (id: string) => {
    const w = state.watchers[id]!;
    const v = await pick({ title: w.name, choices: [{ value: "run", label: "Run now" }, { value: "edit", label: "Edit…" }, { value: "delete", label: "Delete", destructive: true }] });
    if (v === "run") void act(() => client.runWatcher(id), "Watcher started");
    if (v === "edit") router.push({ pathname: "/watcher", params: { id } });
    if (v === "delete" && (await confirm(`Delete watcher “${w.name}”?`, "", "Delete"))) void act(() => client.deleteWatcher(id), "Watcher deleted");
  };
  return (
    <Group
      title="Watchers"
      footer="Commands that emit work items. Each new item opens a triage session in the Inbox."
      right={
        <Pressable onPress={() => router.push("/watcher")} hitSlop={8} accessibilityRole="button" accessibilityLabel="Add watcher">
          <Icon name="plus" size={17} color={c.accent} strokeWidth={2.25} />
        </Pressable>
      }
    >
      {watchers.length === 0 && <SRow title="No watchers yet" sub="Add a command like watch-jira to feed work into triage." onPress={() => router.push("/watcher")} last />}
      {watchers.map((w, i) => (
        <SRow
          key={w.id}
          last={i === watchers.length - 1}
          onPress={() => void menu(w.id)}
          title={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Text style={{ color: c.text, fontSize: 16 }}>{w.name}</Text>
              <Badge>{w.mode === "loop" ? "Loop" : `Every ${w.intervalSec}s`}</Badge>
              {!w.enabled && <Badge outline>Paused</Badge>}
            </View>
          }
          sub={
            <View style={{ gap: 2 }}>
              <Text style={{ color: c.text3, fontSize: 12.5, fontFamily: MONO }} numberOfLines={2}>
                {[w.command, ...w.args].join(" ")}
              </Text>
              <Text style={{ color: c.text3, fontSize: 12.5 }}>
                {driverName(w.driver)} · last run {relativeTime(w.lastRunAt)}
                {w.cwd ? ` · in ${w.cwd}` : ""}
              </Text>
              {w.lastError && <Text style={{ color: c.red, fontSize: 12.5 }}>{w.lastError}</Text>}
            </View>
          }
        >
          <SSwitch label={`Enable ${w.name}`} value={w.enabled} onChange={(v) => void act(() => client.updateWatcher(w.id, { enabled: v }))} />
        </SRow>
      ))}
    </Group>
  );
}

function MappingsSection() {
  const { state, client } = useStore();
  const act = useAction();
  const c = useColors();
  const inputStyle = useInputStyle();
  const projects = sortedProjects(state);
  const [pattern, setPattern] = useState("");
  const [projectId, setProjectId] = useState("");
  const [notes, setNotes] = useState("");
  const mappings = Object.values(state.mappings).sort((a, b) => a.pattern.localeCompare(b.pattern));
  const pid = projectId || projects[0]?.id || "";
  const add = async () => {
    if (!pattern.trim() || !pid) return;
    const ok = await act(() => client.createMapping({ pattern: pattern.trim(), projectId: pid, notes: notes.trim() }), "Mapping added");
    if (ok) {
      setPattern("");
      setNotes("");
    }
  };
  const chooseProject = async () => {
    const v = await pick({ title: "Project", selected: pid, choices: projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.name}` })) });
    if (v) setProjectId(v);
  };
  return (
    <Group title="Mappings" footer="Route external ticket keys to local projects. A key prefix (FOO matches FOO-123) or /regex/. Longest prefix wins.">
      {mappings.length === 0 && <SRow title={<Text style={{ color: c.text3, fontSize: 15 }}>No mappings. Triage picks a project on its own.</Text>} />}
      {mappings.map((m) => {
        const p = state.projects[m.projectId];
        return (
          <SRow
            key={m.id}
            title={<Text style={{ color: c.text, fontFamily: MONO, fontSize: 15 }}>{m.pattern}</Text>}
            sub={`${p ? `${p.key} · ${p.name}` : "Unknown project"}${m.notes ? ` — ${m.notes}` : ""}`}
            onPress={async () => {
              if (await confirm(`Delete mapping ${m.pattern}?`, "", "Delete")) void act(() => client.deleteMapping(m.id));
            }}
          >
            <Icon name="trash" size={15} color={c.red} />
          </SRow>
        );
      })}
      <SRow title="Add mapping" stacked last>
        <View style={{ gap: 8 }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput style={[inputStyle, { flex: 1, fontFamily: MONO, fontSize: 14 }]} placeholder="FOO or /^FOO-\d+/" placeholderTextColor={c.text3} value={pattern} onChangeText={setPattern} autoCapitalize="characters" autoCorrect={false} />
            <PickerButton label={state.projects[pid]?.key ?? "Project"} onPress={() => void chooseProject()} disabled={!projects.length} />
          </View>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <TextInput style={[inputStyle, { flex: 1 }]} placeholder="Notes (optional)" placeholderTextColor={c.text3} value={notes} onChangeText={setNotes} />
            <Button title="Add" variant="primary" disabled={!pattern.trim() || !pid} onPress={() => void add()} />
          </View>
        </View>
      </SRow>
    </Group>
  );
}

function ProjectsSection() {
  const { state, client } = useStore();
  const act = useAction();
  const c = useColors();
  const router = useRouter();
  const projects = sortedProjects(state);
  const add = () =>
    Alert.prompt("Add project", "The folder's absolute path on the Mac, e.g. /Users/you/Sites/app", async (path) => {
      if (path?.trim()) await act(() => client.createProject({ path: path.trim() }), "Project added");
    });
  return (
    <Group
      title="Projects"
      footer="Name, identifier, folder, driver and review settings are set per project."
      right={
        <Pressable onPress={add} hitSlop={8} accessibilityRole="button" accessibilityLabel="Add project">
          <Icon name="plus" size={17} color={c.accent} strokeWidth={2.25} />
        </Pressable>
      }
    >
      {projects.length === 0 && <SRow title="No projects yet" sub="Add one with +." last />}
      {projects.map((p, i) => (
        <SRow
          key={p.id}
          chevron
          last={i === projects.length - 1}
          onPress={() => router.push({ pathname: "/project/[id]", params: { id: p.id } })}
          title={
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              <ProjectKey k={p.key} />
              <Text style={{ color: c.text, fontSize: 16 }}>{p.name}</Text>
            </View>
          }
          sub={<Text style={{ color: c.text3, fontSize: 12, fontFamily: MONO }}>{tildify(p.path)}</Text>}
        />
      ))}
    </Group>
  );
}
