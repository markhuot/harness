// Model defaults: global per-driver default + review model (Settings → Models), and the
// per-project default-model rows (Project settings → Agents).

import { useEffect, useRef } from "react";
import type { Project, PublicSettings } from "@harness/shared";
import { useAction, useStore } from "../../state/store";
import { inheritedModel, modelCacheFor } from "../../state/models";
import { ModelSelect } from "../../components/ModelSelect";
import { Row, Section } from "../Settings";

export function ModelsSection({ settings }: { settings: PublicSettings }) {
  const { state, client } = useStore();
  const act = useAction();

  // A new / cleared API key changes what anthropic-api can list.
  const keySet = useRef(settings.anthropicApiKeySet);
  useEffect(() => {
    if (keySet.current === settings.anthropicApiKeySet) return;
    keySet.current = settings.anthropicApiKeySet;
    void modelCacheFor(client).load("anthropic-api", true);
  }, [client, settings.anthropicApiKeySet]);

  const saveMap = (field: "defaultModels" | "reviewModels", driver: string, model: string | null) =>
    void act(() => client.updateSettings({ [field]: { [driver]: model } }));

  return (
    <Section id="models" title="Models" desc="Tickets and projects can pick their own model; these apply when they don't.">
      <div className="card-surface settings-card">
        {state.drivers.map((d) => (
          <Row key={d.id} title={d.name} sub="Default model · model for agent review runs">
            <div className="stack" style={{ gap: 6, alignItems: "flex-end" }} data-testid={`model-settings-${d.id}`}>
              <ModelSelect
                driver={d.id}
                value={settings.defaultModels[d.id] ?? null}
                inherited={inheritedModel(d.id, "settings", null, settings)}
                onChange={(m) => saveMap("defaultModels", d.id, m)}
                showRefresh
              />
              <ModelSelect
                driver={d.id}
                value={settings.reviewModels[d.id] ?? null}
                defaultLabel="Review: same as work"
                plainDefault
                onChange={(m) => saveMap("reviewModels", d.id, m)}
              />
            </div>
          </Row>
        ))}
      </div>
    </Section>
  );
}

export function ProjectModelRows({ project, save }: { project: Project; save: (patch: { defaultModels: Record<string, string | null> }) => unknown }) {
  const { state } = useStore();
  return (
    <Row title="Default models" sub="Per driver, for this project's tickets. Default follows the global setting.">
      <div className="stack" style={{ gap: 6, alignItems: "flex-end" }} data-testid="project-models">
        {state.drivers.map((d) => (
          <label key={d.id} className="row" style={{ gap: 8, fontSize: 12 }}>
            <span className="muted">{d.name}</span>
            <ModelSelect
              driver={d.id}
              value={project.defaultModels?.[d.id] ?? null}
              inherited={inheritedModel(d.id, "project", project, state.settings)}
              onChange={(m) => void save({ defaultModels: { [d.id]: m } })}
            />
          </label>
        ))}
      </div>
    </Row>
  );
}
