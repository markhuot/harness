// A project's default driver + model (Project settings → Agents). The app's default model and
// the per-driver review models live in Settings → Drivers (DriverSettings.tsx).

import type { Project } from "@harness/shared";
import { useStore } from "../../state/store";
import { inheritedModel, projectChoice, projectChoicePatch } from "@harness/shared/state";
import { DriverModelSelect } from "../../components/ModelSelect";
import { Row } from "../Settings";

export function ProjectModelRow({ project, save }: { project: Project; save: (patch: { defaultDriver: string | null; defaultModels: Record<string, string | null> }) => unknown }) {
  const { state } = useStore();
  const settings = state.settings;
  return (
    <Row title="Default model" sub="Used for new sessions in this project. Global default follows the app setting.">
      <span data-testid="project-models">
        <DriverModelSelect
          value={projectChoice(project, settings)}
          resolved={settings ? { driver: settings.defaultDriver, model: inheritedModel(settings.defaultDriver, "project", project, settings) } : { driver: null, model: null }}
          defaultLabel="Global default"
          autoWidth
          inheritedModel={(d) => inheritedModel(d, "project", project, settings)}
          onChange={(c) => void save(projectChoicePatch(c, project))}
        />
      </span>
    </Row>
  );
}
