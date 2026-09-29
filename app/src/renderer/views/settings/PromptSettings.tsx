// Settings → Prompts: the built-in agent prompts (GET /prompts), each either built-in (follows
// app updates) or customized (settings.prompts). DESIGN.md "Prompt overrides".

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { PromptEntry, PromptId } from "@harness/shared";
import {
  brokenOverrideMessage,
  groupPrompts,
  HarnessApiError,
  insertText,
  lineDiff,
  PROMPT_STATE_LABELS,
  promptDraftDirty,
  promptDraftError,
  promptSavePatch,
  promptStartText,
  promptState,
} from "@harness/shared";
import { useStore } from "../../state/store";
import { Icon } from "../../components/Icon";
import { Section } from "../Settings";
import "./prompts.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PromptsSection() {
  const { client, onEvent } = useStore();
  const [prompts, setPrompts] = useState<PromptEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [open, setOpen] = useState<PromptId | null>(null);
  // Set by the open editor so switching prompts can ask before dropping unsaved text.
  const dirty = useRef(false);

  const load = useCallback(async () => {
    try {
      setPrompts(await client.listPrompts());
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof HarnessApiError && e.status === 404 ? "This service doesn't support prompt overrides yet. Update Harness to customize prompts." : errorText(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
    return onEvent((e) => {
      if (e.kind === "settings.updated") void load();
    });
  }, [load, onEvent]);

  const toggle = (id: PromptId) => {
    if (dirty.current && !confirm("Discard your unsaved changes to this prompt?")) return;
    dirty.current = false;
    setOpen((cur) => (cur === id ? null : id));
  };

  const customized = prompts?.filter((p) => promptState(p) !== "builtin").length ?? 0;
  const broken = prompts?.filter((p) => promptState(p) === "broken").length ?? 0;

  return (
    <Section
      id="prompts"
      title="Prompts"
      desc="The instructions Harness gives agents. A built-in prompt picks up improvements with each app update; a customized one stays as you wrote it until you reset it."
      actions={
        prompts && (
          <span className="prompts-count">
            {broken > 0 && (
              <span className="badge badge-red">
                <Icon name="alert" /> {broken} not in use
              </span>
            )}
            {customized > 0 ? `${customized} customized` : "All built-in"}
          </span>
        )
      }
    >
      {!prompts ? (
        <div className="card-surface empty">
          {loadError ? (
            <>
              <Icon name="alert" />
              {loadError}
            </>
          ) : (
            <>
              <div className="spinner" />
              Loading prompts…
            </>
          )}
        </div>
      ) : (
        groupPrompts(prompts).map((g) => (
          <div key={g.group} className="prompts-group" data-testid={`prompts-${g.group}`}>
            <div className="prompts-group-head">
              <div className="prompts-group-title">{g.title}</div>
              <div className="settings-row-sub">{g.description}</div>
            </div>
            <div className="card-surface settings-card">
              {g.entries.map((p) => (
                <div key={p.id} className="prompt-item">
                  <button className={`settings-row link prompt-row${open === p.id ? " open" : ""}`} data-prompt={p.id} onClick={() => toggle(p.id)} aria-expanded={open === p.id}>
                    <div className="settings-row-main">
                      <div className="settings-row-title">
                        {p.label}
                        <PromptBadge entry={p} />
                      </div>
                      <div className="settings-row-sub">{p.description}</div>
                    </div>
                    <Icon name={open === p.id ? "chevronDown" : "chevronRight"} size={14} />
                  </button>
                  {open === p.id && <PromptEditor entry={p} dirtyRef={dirty} onSaved={load} />}
                </div>
              ))}
            </div>
          </div>
        ))
      )}
    </Section>
  );
}

function PromptBadge({ entry }: { entry: PromptEntry }) {
  const state = promptState(entry);
  if (state === "broken")
    return (
      <span className="badge badge-red" title={entry.overrideError ?? undefined}>
        <Icon name="alert" /> {PROMPT_STATE_LABELS.broken}
      </span>
    );
  return <span className={state === "customized" ? "badge badge-accent" : "badge"}>{PROMPT_STATE_LABELS[state]}</span>;
}

/** Rows for the textarea: its lines as they wrap at about 90 characters, within 8–28. */
function editorRows(text: string) {
  const rows = text.split("\n").reduce((n, line) => n + Math.max(1, Math.ceil(line.length / 90)), 1);
  return Math.min(28, Math.max(8, rows));
}

function PromptEditor({ entry, dirtyRef, onSaved }: { entry: PromptEntry; dirtyRef: MutableRefObject<boolean>; onSaved: () => Promise<void> }) {
  const { client, toast } = useStore();
  // null: showing the built-in read-only; a string: the text being edited.
  const [draft, setDraft] = useState<string | null>(entry.override);
  const [compare, setCompare] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  const editing = draft !== null;
  const liveError = editing ? promptDraftError(entry, draft) : null;
  const dirty = editing && promptDraftDirty(entry, draft);
  const state = promptState(entry);
  dirtyRef.current = dirty;
  useEffect(() => () => void (dirtyRef.current = false), [dirtyRef]);

  const change = (text: string) => {
    setDraft(text);
    setServerError(null);
  };

  const save = async (value: string | null, message: string) => {
    setSaving(true);
    setServerError(null);
    try {
      await client.updateSettings(promptSavePatch(entry, value));
      const stored = value === null ? null : promptSavePatch(entry, value).prompts![entry.id];
      if (stored == null) setDraft(null);
      dirtyRef.current = false;
      toast(message, "info");
      await onSaved();
    } catch (e) {
      // Keep the text: the service's 400 says what to fix.
      setServerError(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const submit = () => {
    if (!editing || !dirty || liveError || saving) return;
    const resets = promptSavePatch(entry, draft).prompts![entry.id] == null;
    void save(draft, resets ? "Prompt reset to built-in" : "Prompt saved");
  };

  const cancel = () => {
    setServerError(null);
    setDraft(entry.override);
  };

  const reset = () => {
    if (confirm(`Reset “${entry.label}” to the built-in prompt? Your text is discarded, and the prompt follows app updates again.`)) void save(null, "Prompt reset to built-in");
  };

  const insertVar = (name: string) => {
    const el = area.current;
    if (!el || draft === null) return;
    const next = insertText(draft, el.selectionStart, el.selectionEnd, `{{${name}}}`);
    change(next.text);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
    });
  };

  const shown = draft ?? entry.builtin;
  const error = serverError ?? liveError;
  // A broken override's banner already says what's wrong until the text changes.
  const errorLine = state === "broken" && !serverError && draft === entry.override ? null : error;

  return (
    <div
      className="settings-form prompt-editor"
      data-testid="prompt-editor"
      onKeyDown={(e) => {
        if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      }}
    >
      {state === "broken" && (
        <div className="prompt-broken" role="alert">
          <Icon name="alert" size={14} />
          <div>{brokenOverrideMessage(entry)}</div>
        </div>
      )}

      <div className="prompt-editor-bar">
        {editing ? (
          <div className="segmented">
            <button type="button" className={compare ? "" : "on"} onClick={() => setCompare(false)}>
              Edit
            </button>
            <button type="button" className={compare ? "on" : ""} onClick={() => setCompare(true)} title="Show what differs from the built-in" data-testid="prompt-compare">
              Compare with built-in
            </button>
          </div>
        ) : (
          <span className="prompt-editor-label">Built-in text · read-only</span>
        )}
        <div className="grow" />
        {!editing && (
          <button className="btn btn-sm btn-primary" onClick={() => change(promptStartText(entry))}>
            <Icon name="edit" size={12} /> Customize
          </button>
        )}
        {entry.override !== null && (
          <button className="btn btn-sm btn-danger" onClick={reset} disabled={saving}>
            <Icon name="refresh" size={12} /> Reset to built-in
          </button>
        )}
      </div>

      {compare && editing ? (
        <PromptDiff from={entry.builtin} to={draft} />
      ) : (
        <textarea
          ref={area}
          className={`textarea mono prompt-text${error ? " invalid" : ""}`}
          data-testid="prompt-text"
          spellCheck={false}
          readOnly={!editing}
          rows={editorRows(shown)}
          value={shown}
          onChange={(e) => change(e.target.value)}
          aria-label={`${entry.label} prompt`}
          aria-invalid={!!error}
        />
      )}

      {errorLine && (
        <div className="settings-row-err prompt-error" data-testid="prompt-error">
          {errorLine}
        </div>
      )}

      <div className="field-hint">
        {editing
          ? "A customized prompt doesn't pick up built-in improvements from app updates. Reset it to follow the built-in again. Leaving it empty, or the same as the built-in, saves it as built-in."
          : "Built-in: this text improves with app updates while the prompt isn't customized."}
      </div>

      {entry.variables.length > 0 && (
        <div className="prompt-vars">
          <div className="prompt-vars-title">
            Variables{editing && <span className="dim"> · click to insert</span>}
          </div>
          <div className="prompt-vars-list">
            {entry.variables.map((v) => (
              <div key={v.name} className="prompt-var">
                <button type="button" className="prompt-var-name mono" disabled={!editing || compare} onClick={() => insertVar(v.name)} title={editing ? `Insert {{${v.name}}}` : undefined}>
                  {`{{${v.name}}}`}
                </button>
                <span className="prompt-var-desc">{v.description}</span>
              </div>
            ))}
          </div>
          <div className="field-hint">
            <span className="mono">{"{{#if name}} … {{else}} … {{/if}}"}</span> includes text only when a variable is set (true or not empty).
          </div>
        </div>
      )}

      {editing && (
        <div className="settings-form-foot">
          <span className="field-hint grow">{dirty ? "Unsaved changes · ⌘S saves" : ""}</span>
          <button type="button" className="btn btn-ghost" onClick={cancel} disabled={saving || (!dirty && entry.override !== null)}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!dirty || !!liveError || saving} data-testid="prompt-save">
            {saving && <span className="spinner" />}
            Save
          </button>
        </div>
      )}
    </div>
  );
}

function PromptDiff({ from, to }: { from: string; to: string }) {
  const lines = lineDiff(from, to);
  const changed = lines.some((l) => l.type !== "same");
  return (
    <div className="prompt-diff mono" data-testid="prompt-diff">
      {!changed && <div className="prompt-diff-empty">Same as the built-in.</div>}
      {lines.map((l, i) => (
        <div key={i} className={`prompt-diff-line ${l.type}`}>
          <span className="prompt-diff-mark">{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
          {l.text || " "}
        </div>
      ))}
    </div>
  );
}
