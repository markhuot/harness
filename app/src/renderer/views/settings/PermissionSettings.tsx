// Permissions: the global permission mode + auto-mode classifier backend (Settings →
// Permissions), and the per-project override row (Project settings → Agents).

import type { ClassifierBackend, PermissionMode, Project, PublicSettings } from "@harness/shared";
import { CLASSIFIER_BACKENDS, PERMISSION_MODE_LABELS } from "@harness/shared";
import { useAction, useStore } from "../../state/store";
import { PermissionModeSelect } from "../../components/PermissionModeSelect";
import { Row, Section } from "../Settings";

const CLASSIFIER_LABELS: Record<ClassifierBackend, string> = {
  "claude-cli": "Claude CLI (your Claude plan)",
  "anthropic-api": "Anthropic API (API key)",
  off: "Off (ask me instead)",
};

export function PermissionsSection({ settings }: { settings: PublicSettings }) {
  const { client } = useStore();
  const act = useAction();
  const save = (body: { permissionMode?: PermissionMode; classifier?: ClassifierBackend }) => void act(() => client.updateSettings(body));
  return (
    <Section
      id="permissions"
      title="Permissions"
      desc="How much agents may do without asking. Projects and tickets can override the mode. Plan runs are always read-only."
    >
      <div className="card-surface settings-card">
        <Row title="Default mode" sub={PERMISSION_MODE_LABELS[settings.permissionMode].description}>
          <PermissionModeSelect value={settings.permissionMode} onChange={(m) => m && save({ permissionMode: m })} />
        </Row>
        <Row
          title="Auto-mode classifier"
          sub="Judges actions in auto mode for the Anthropic API and Dummy drivers, using Claude Code's auto-mode rules. Claude Code tickets use Claude Code's own classifier."
        >
          <select className="select" aria-label="Classifier" data-testid="classifier-backend" value={settings.classifier} onChange={(e) => save({ classifier: e.target.value as ClassifierBackend })}>
            {CLASSIFIER_BACKENDS.map((b) => (
              <option key={b} value={b}>
                {CLASSIFIER_LABELS[b]}
              </option>
            ))}
          </select>
        </Row>
      </div>
    </Section>
  );
}

export function ProjectPermissionRow({ project, save }: { project: Project; save: (patch: { permissionMode: PermissionMode | null }) => unknown }) {
  const { state } = useStore();
  const inherited = state.settings?.permissionMode ?? "auto";
  const effective = project.permissionMode ?? inherited;
  return (
    <Row title="Permission mode" sub={`${PERMISSION_MODE_LABELS[effective].description} Default follows the global setting; tickets can override it.`}>
      <PermissionModeSelect value={project.permissionMode} inherited={inherited} onChange={(m) => void save({ permissionMode: m })} />
    </Row>
  );
}
