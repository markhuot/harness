// The service runs older code than this app (a merge landed after it started). Shown until the
// service restarts onto the new code: there's no dismiss. "Restart now" does it right away, at
// the cost of the agents that are running.

import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { Icon } from "./Icon";
import { Modal } from "./bits";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function ServiceBanner() {
  const { serviceCode, serviceStale, restartService, state, toast } = useStore();
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const running = Object.values(state.sessions).filter((s) => s.busy).length;
  // A service from before build tracking never restarts by itself.
  const selfRestarts = serviceCode?.build !== undefined;

  // The restarted service reconnects with a fresh /health that hides the banner; if it comes back
  // stale anyway (or never drops the connection), let the button be pressed again.
  useEffect(() => {
    if (!serviceStale) setRestarting(false);
  }, [serviceStale]);
  useEffect(() => {
    if (!restarting) return;
    const t = setTimeout(() => setRestarting(false), 30_000);
    return () => clearTimeout(t);
  }, [restarting]);

  if (!serviceStale) return null;

  const restart = async () => {
    setConfirming(false);
    setRestarting(true);
    try {
      await restartService();
    } catch (e) {
      setRestarting(false);
      toast((e as Error).message || String(e), "error");
    }
  };

  return (
    <>
      <div className="service-banner" role="status" data-testid="service-banner">
        <Icon name="alert" size={15} />
        <div className="service-banner-text">
          <strong>The harness service is running older code than this app.</strong>{" "}
          <span className="dim">
            {selfRestarts ? "It restarts onto the new code by itself once no agents are running." : "Restart it to pick up the new code."}{" "}
            Restarting now stops {running ? plural(running, "running agent", "running agents") : "any running agents"}.
          </span>
        </div>
        <button
          className="btn btn-sm"
          data-testid="service-restart"
          disabled={restarting}
          onClick={() => (running ? setConfirming(true) : void restart())}
        >
          {restarting ? <span className="spinner" /> : <Icon name="refresh" />}
          {restarting ? "Restarting…" : "Restart now"}
        </button>
      </div>
      {confirming && (
        <Modal onClose={() => setConfirming(false)} width={440}>
          <div className="modal-head">
            <strong>Restart the service?</strong>
          </div>
          <div className="modal-body">
            <p style={{ margin: 0 }}>
              {plural(running, "agent is", "agents are")} running. Restarting now stops {running === 1 ? "it" : "them"} mid-run: the runs
              are cancelled, and their tickets stay where they are until you message them to pick up again.
            </p>
            {selfRestarts && (
              <p className="dim" style={{ margin: "8px 0 0" }}>
                Or wait: the service restarts by itself once no agents are running.
              </p>
            )}
          </div>
          <div className="modal-foot">
            <div className="grow" />
            <button className="btn btn-ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn btn-primary" data-testid="service-restart-confirm" onClick={() => void restart()}>
              Stop {plural(running, "agent", "agents")} and restart
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
