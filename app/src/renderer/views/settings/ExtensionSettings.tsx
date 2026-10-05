// Settings → Extensions: the Chrome extensions of the browser every ticket's tabs share
// (GET /browser-extensions). Web Store extensions install through Chrome itself, so the
// organization's Chrome policy applies; an unpacked folder (this Mac only) loads as it is. A Web
// Store install lands when Chrome next starts, which Restart browser does on demand.

import { useCallback, useEffect, useState } from "react";
import type { BrowserExtension, BrowserExtensionList } from "@harness/shared";
import { useStore } from "../../state/store";
import { Icon } from "../../components/Icon";
import { Switch } from "../../components/bits";
import { Section } from "../Settings";
import { extensionNote, extensionsWaiting } from "@harness/shared/state";
import "./extensions.css";

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ExtensionsSection() {
  const { client, toast } = useStore();
  const [list, setList] = useState<BrowserExtensionList | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState<"webstore" | "unpacked" | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await client.listBrowserExtensions());
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  const waiting = list ? extensionsWaiting(list) : 0;
  // Chrome also restarts on its own once every tab is idle: look again now and then while one waits.
  useEffect(() => {
    if (!list?.extensions.some((e) => e.status === "pending")) return;
    const t = setInterval(() => void load(), 10_000);
    return () => clearInterval(t);
  }, [list, load]);

  const add = async (kind: "webstore" | "unpacked", value: string) => {
    setAdding(kind);
    setAddError(null);
    try {
      const ext = await client.addBrowserExtension(kind === "webstore" ? { webstore: value } : { path: value });
      if (kind === "webstore") setDraft("");
      toast(ext.status === "pending" ? `${ext.name} installs when the browser restarts.` : `Added ${ext.name}.`, "info");
    } catch (e) {
      setAddError(errorText(e));
    } finally {
      setAdding(null);
      void load();
    }
  };

  const addFolder = async () => {
    const path = await window.harness?.pickDirectory({ title: "Add an unpacked extension", buttonLabel: "Add extension" });
    if (path) await add("unpacked", path);
  };

  /** Run a change to one extension, showing its row busy and any error as a toast. */
  const change = async (ext: BrowserExtension, fn: () => Promise<unknown>) => {
    setBusy((b) => new Set(b).add(ext.id));
    try {
      await fn();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setBusy((b) => {
        const next = new Set(b);
        next.delete(ext.id);
        return next;
      });
      void load();
    }
  };

  const remove = (ext: BrowserExtension) => {
    if (!confirm(`Remove ${ext.name} from the browser?`)) return;
    void change(ext, () => client.removeBrowserExtension(ext.id));
  };

  const restart = async () => {
    if (!confirm("Restart the browser? Every ticket's open pages reload.")) return;
    setRestarting(true);
    try {
      await client.restartBrowser();
    } catch (e) {
      toast(errorText(e), "error");
    } finally {
      setRestarting(false);
      void load();
    }
  };

  const mine = list?.extensions.filter((e) => e.source !== "chrome") ?? [];
  const others = list?.extensions.filter((e) => e.source === "chrome") ?? [];

  return (
    <Section
      id="extensions"
      title="Extensions"
      desc="Chrome extensions for the browser every ticket's tabs share. Add one from the Chrome Web Store, or an extension you're building from its folder. Your organization's Chrome policy applies, as it does in Chrome. Run an extension's toolbar button from the puzzle menu in a ticket's browser."
    >
      <div className="card-surface settings-card" data-testid="extensions-section">
        <form
          className="settings-row extensions-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (draft.trim() && !adding) void add("webstore", draft.trim());
          }}
        >
          <input
            className="input grow"
            value={draft}
            placeholder="Chrome Web Store link or extension ID"
            aria-label="Chrome Web Store link or extension ID"
            spellCheck={false}
            disabled={!!adding}
            data-testid="extensions-webstore"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="btn" type="submit" disabled={!draft.trim() || !!adding} data-testid="extensions-add">
            {adding === "webstore" ? <span className="spinner" /> : <Icon name="plus" />}
            {adding === "webstore" ? "Installing…" : "Add"}
          </button>
          {window.harness && (
            <button className="btn btn-ghost" type="button" disabled={!!adding} title="Load an unpacked extension from a folder on this Mac" onClick={() => void addFolder()}>
              {adding === "unpacked" ? <span className="spinner" /> : <Icon name="folder" />}
              Add folder…
            </button>
          )}
        </form>
        {addError && (
          <div className="settings-row extensions-add-error" role="alert" data-testid="extensions-add-error">
            <Icon name="alert" />
            <span className="settings-row-err">{addError}</span>
          </div>
        )}
        {waiting > 0 && (
          <div className="settings-row extensions-waiting" data-testid="extensions-waiting">
            <div className="settings-row-main">
              <div className="settings-row-title">
                {waiting === 1 ? "1 extension installs" : `${waiting} extensions install`} when the browser restarts
              </div>
              <div className="settings-row-sub">The browser restarts on its own once no ticket uses it, or restart it now (open pages reload).</div>
            </div>
            <button className="btn" disabled={restarting} onClick={() => void restart()} data-testid="extensions-restart">
              {restarting ? <span className="spinner" /> : <Icon name="refresh" />}
              {restarting ? "Restarting…" : "Restart browser"}
            </button>
          </div>
        )}
        {!list ? (
          <div className="settings-row">
            {loadError ? <span className="settings-row-err">{loadError}</span> : <span className="spinner" />}
          </div>
        ) : mine.length === 0 ? (
          <div className="settings-row settings-row-sub extensions-empty">No extensions added yet.</div>
        ) : (
          mine.map((ext) => <ExtensionRow key={ext.id} ext={ext} busy={busy.has(ext.id)} onToggle={(on) => void change(ext, () => client.setBrowserExtensionEnabled(ext.id, on))} onRemove={() => remove(ext)} />)
        )}
      </div>
      {others.length > 0 && (
        <>
          <div className="settings-section-desc extensions-others-head">Also in the browser</div>
          <div className="card-surface settings-card" data-testid="extensions-others">
            {others.map((ext) => (
              <ExtensionRow key={ext.id} ext={ext} />
            ))}
          </div>
        </>
      )}
    </Section>
  );
}

function ExtensionRow({ ext, busy, onToggle, onRemove }: { ext: BrowserExtension; busy?: boolean; onToggle?: (on: boolean) => void; onRemove?: () => void }) {
  const note = extensionNote(ext);
  return (
    <div className="settings-row extension-row" data-testid="extension-row" data-id={ext.id} data-status={ext.status}>
      <Icon name="puzzle" size={16} className="extension-icon" />
      <div className="settings-row-main">
        <div className="settings-row-title">
          <span className="truncate">{ext.name}</span>
          {ext.version && <span className="extension-version mono">{ext.version}</span>}
          {note.badge && <span className={`badge ${note.tone === "error" ? "badge-red" : ""}`}>{note.badge}</span>}
        </div>
        {note.text && <div className={note.tone === "error" ? "settings-row-err" : "settings-row-sub"}>{note.text}</div>}
        {ext.path && (
          <div className="settings-row-sub mono" title={ext.path}>
            {ext.path}
          </div>
        )}
      </div>
      {onToggle && onRemove && (
        <div className="settings-row-actions">
          {busy && <span className="spinner" />}
          <Switch checked={ext.enabled} disabled={busy} ariaLabel={`${ext.name} on`} onChange={onToggle} />
          <button className="btn btn-ghost btn-icon btn-sm" title={`Remove ${ext.name}`} aria-label={`Remove ${ext.name}`} disabled={busy} onClick={onRemove}>
            <Icon name="trash" />
          </button>
        </div>
      )}
    </div>
  );
}
