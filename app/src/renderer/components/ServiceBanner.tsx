// The service notice at the bottom of the main area (state/service.ts serviceNotice):
//  - stale: the service runs older code than this app (a merge landed after it started). Shown
//    until it restarts onto the new code: there's no dismiss.
//  - deferred: this build of the app installed a different login item while agents were running,
//    so the service it replaces keeps going until they finish; the app then reloads it.
//  - unreachable: the socket has been down for a while. Retry starts the service again.
// "Restart now" restarts it right away, at the cost of the agents that are running. ServiceLoading
// stands in for a window that hasn't loaded anything yet, and says so when the service is gone.

import { useEffect, useState } from "react";
import { useStore } from "../state/store";
import { serviceNotice, UNREACHABLE_AFTER_MS } from "../state/service";
import { Icon } from "./Icon";
import { Modal } from "./bits";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The current notice, re-checked once the socket has been down long enough to count. */
function useServiceNotice() {
  const { serviceStale, serviceDeferred, serviceDownSince } = useStore();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    if (serviceDownSince === null) return;
    const t = setTimeout(() => setNow(Date.now()), Math.max(0, serviceDownSince + UNREACHABLE_AFTER_MS - Date.now()));
    return () => clearTimeout(t);
  }, [serviceDownSince]);
  return serviceNotice({ stale: serviceStale, deferred: serviceDeferred, downSince: serviceDownSince, now });
}

function RetryButton({ primary }: { primary?: boolean }) {
  const { retryService, toast } = useStore();
  const [retrying, setRetrying] = useState(false);
  if (!retryService) return null;
  const retry = async () => {
    setRetrying(true);
    try {
      await retryService();
    } catch (e) {
      toast((e as Error).message || String(e), "error");
    } finally {
      setRetrying(false);
    }
  };
  return (
    <button className={`btn btn-sm${primary ? " btn-primary" : ""}`} data-testid="service-retry" disabled={retrying} onClick={() => void retry()}>
      {retrying ? <span className="spinner" /> : <Icon name="refresh" />}
      {retrying ? "Starting…" : "Retry"}
    </button>
  );
}

/** The main area before the first snapshot: a spinner, or why nothing is coming. */
export function ServiceLoading() {
  const { client } = useStore();
  const notice = useServiceNotice();
  if (notice !== "unreachable") {
    return (
      <div className="empty" style={{ flex: 1 }}>
        <div className="spinner" />
      </div>
    );
  }
  return (
    <div className="service-unreachable" data-testid="service-unreachable">
      <div className="error-card card-surface">
        <div className="error-icon">
          <Icon name="wifiOff" size={20} />
        </div>
        <h2>Can't reach the harness service</h2>
        <p className="dim">
          Nothing is answering at <code>{client.baseUrl}</code>. The service may have stopped. Retry starts it again.
        </p>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <span className="muted grow" style={{ fontSize: 12 }}>
            The service log is <code>~/.harness/logs/service.log</code>
          </span>
          <RetryButton primary />
        </div>
      </div>
    </div>
  );
}

export function ServiceBanner() {
  const { serviceCode, restartService, state, toast } = useStore();
  const notice = useServiceNotice();
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const running = Object.values(state.sessions).filter((s) => s.busy).length;
  // A service from before build tracking never restarts by itself; a deferred one is reloaded by the app.
  const selfRestarts = notice === "deferred" || serviceCode?.build !== undefined;

  // The restarted service reconnects with a fresh /health that hides the banner; if it comes back
  // stale anyway (or never drops the connection), let the button be pressed again.
  useEffect(() => {
    if (notice !== "stale" && notice !== "deferred") setRestarting(false);
  }, [notice]);
  useEffect(() => {
    if (!restarting) return;
    const t = setTimeout(() => setRestarting(false), 30_000);
    return () => clearTimeout(t);
  }, [restarting]);

  // Before the first snapshot ServiceLoading explains an unreachable service.
  if (!notice || (notice === "unreachable" && !state.ready)) return null;

  if (notice === "unreachable") {
    return (
      <div className="service-banner" role="status" data-testid="service-banner">
        <Icon name="wifiOff" size={15} />
        <div className="service-banner-text">
          <strong>Lost the connection to the harness service.</strong> <span className="dim">It keeps trying to reconnect. Retry starts the service again if it stopped.</span>
        </div>
        <RetryButton />
      </div>
    );
  }

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
          {notice === "deferred" ? (
            <>
              <strong>Harness was updated, but the service is still the previous version.</strong>{" "}
              <span className="dim">
                Switching over restarts it, so it waits until {running ? plural(running, "running agent finishes", "running agents finish") : "no agents are running"}.
              </span>
            </>
          ) : (
            <>
              <strong>The harness service is running older code than this app.</strong>{" "}
              <span className="dim">
                {selfRestarts ? "It restarts onto the new code by itself once no agents are running." : "Restart it to pick up the new code."}{" "}
                Restarting now stops {running ? plural(running, "running agent", "running agents") : "any running agents"}.
              </span>
            </>
          )}
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
