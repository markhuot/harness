// Model defaults: the app's default driver + model and the per-driver review models
// (Settings → Models), and a project's default driver + model (Project settings → Agents).

import { useEffect, useRef } from "react";
import type { Project, PublicSettings } from "@harness/shared";
import { useAction, useStore } from "../../state/store";
import { inheritedModel, modelCacheFor, projectChoice, projectChoicePatch, settingsChoice, settingsChoicePatch } from "@harness/shared/state";
import { DriverModelSelect, ModelSelect } from "../../components/ModelSelect";
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

  const saveReview = (driver: string, model: string | null) => void act(() => client.updateSettings({ reviewModels: { [driver]: model } }));

  return (
    <Section id="models" title="Models" desc="Tickets and projects can pick their own model; these apply when they don't.">
      <div className="card-surface settings-card">
        <Row title="Default model" sub="Used for new sessions unless the project or ticket picks its own.">
          <DriverModelSelect
            value={settingsChoice(settings)}
            resolved={{ driver: settings.defaultDriver, model: null }}
            defaultLabel="Driver default"
            autoWidth
            onChange={(c) => void act(() => client.updateSettings(settingsChoicePatch(c, settings)))}
          />
        </Row>
        {state.drivers.map((d) => (
          <Row key={d.id} title={d.name} sub="Model for agent review runs">
            <div data-testid={`model-settings-${d.id}`}>
              <ModelSelect driver={d.id} value={settings.reviewModels[d.id] ?? null} defaultLabel="Same as work" plainDefault onChange={(m) => saveReview(d.id, m)} showRefresh />
            </div>
          </Row>
        ))}
      </div>
    </Section>
  );
}

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
