// Settings → Service: who runs the service. By default it's the app's child and stops when the app
// quits; Start at login makes it a launchd agent instead (the packaged app's bundled login item,
// or a dev build's plist), so macOS starts it at login and agents keep running without the app. App-side (the main process switches it), so only in the Mac app.

import { useEffect, useState } from "react";
import type { ConnectionResult } from "../../../main/types";
import { useStore } from "../../state/store";
import { Modal } from "../../components/bits";
import { Row, Section } from "../Settings";

const LABEL = "launchd agent com.markhuot.harness";
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ServiceSection() {
  const { state, toast } = useStore();
  const [conn, setConn] = useState<ConnectionResult | null>(null);
  const [switching, setSwitching] = useState(false);
  const [confirm, setConfirm] = useState<"app" | "login" | null>(null);
  const running = Object.values(state.sessions).filter((s) => s.busy).length;

  useEffect(() => {
    void window.harness?.getConnection().then(setConn);
  }, []);

  if (!window.harness) return null;
  const live = conn && !("error" in conn) ? conn : null;
  const mode = live?.source === "service" ? live.mode : undefined;

  const apply = async (next: "app" | "login") => {
    setConfirm(null);
    setSwitching(true);
    try {
      const res = await window.harness!.setServiceMode(next);
      setConn(res.connection);
      if (res.error) toast(res.error.output ? `${res.error.error} ${res.error.output}` : res.error.error, "error");
      else toast(next === "login" ? "The service now starts when you log in." : "The service now runs inside Harness.", "info");
    } catch (e) {
      toast((e as Error).message || String(e), "error");
    } finally {
      setSwitching(false);
    }
  };
  const request = (next: "app" | "login") => (running ? setConfirm(next) : void apply(next));

  let sub: string;
  let action: { label: string; to: "app" | "login" } | null = null;
  if (!live) sub = "Not connected to the service.";
  else if (live.source === "env") sub = "Connected through HARNESS_URL, so the app doesn't run the service.";
  else if (mode === "login") {
    sub = "On: agents keep running after you quit Harness.";
    action = { label: "Remove", to: "app" };
  } else if (mode === "external") {
    sub = "Started outside the app, so the app doesn't manage it.";
  } else {
    sub = "Off: quitting Harness stops the service and its agents.";
    action = { label: "Install", to: "login" };
  }

  return (
    <Section
      id="service"
      title="Service"
      desc="The background service runs your agents. By default it runs inside the app. Start at login makes it a login item instead, so macOS starts the service when you log in and it keeps running without the app. macOS may ask you to allow Harness in System Settings → Login Items."
    >
      <div className="card-surface settings-card" data-testid="service-section" data-mode={mode ?? "none"}>
        <Row title="Start at login" sub={<span title={mode === "login" ? LABEL : undefined}>{sub}</span>}>
          {action && (
            <button className="btn" data-testid="service-mode" disabled={switching} onClick={() => request(action.to)}>
              {switching && <span className="spinner" />}
              {switching ? (action.to === "login" ? "Installing…" : "Removing…") : action.label}
            </button>
          )}
        </Row>
      </div>
      {confirm && (
        <Modal onClose={() => setConfirm(null)} width={440}>
          <div className="modal-head">
            <strong>{confirm === "login" ? "Start the service at login?" : "Run the service inside Harness?"}</strong>
          </div>
          <div className="modal-body">
            <p style={{ margin: 0 }}>
              The service restarts to make the switch. {plural(running, "agent is", "agents are")} running, and restarting stops{" "}
              {running === 1 ? "it" : "them"} mid-run: the runs are cancelled, and their tickets stay where they are until you message
              them to pick up again.
            </p>
          </div>
          <div className="modal-foot">
            <div className="grow" />
            <button className="btn btn-ghost" onClick={() => setConfirm(null)}>
              Cancel
            </button>
            <button className="btn btn-primary" data-testid="service-mode-confirm" onClick={() => void apply(confirm)}>
              Stop {plural(running, "agent", "agents")} and switch
            </button>
          </div>
        </Modal>
      )}
    </Section>
  );
}
