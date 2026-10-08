// A project's per-phase driver + model choices (Project settings → Agents). The app's own choices
// live in Settings → Drivers (DriverSettings.tsx).

import type { PhaseModelsPatch, Project } from "@harness/shared";
import { inheritedPhaseModels } from "@harness/shared";
import { useStore } from "../../state/store";
import { PhaseModelSelect } from "../../components/PhaseModelSelect";
import { Row } from "../Settings";

export function ProjectModelRow({ project, save }: { project: Project; save: (patch: { phaseModels: PhaseModelsPatch }) => unknown }) {
  const { state } = useStore();
  return (
    <Row title="Models" sub="The driver and model each run phase uses for this project's tickets. Inherit follows the app setting.">
      <span data-testid="project-models">
        <PhaseModelSelect
          value={project.phaseModels}
          inherited={inheritedPhaseModels("project", null, state.settings?.phaseModels)}
          autoWidth
          onChange={(phaseModels) => void save({ phaseModels })}
        />
      </span>
    </Row>
  );
}
