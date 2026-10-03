// Who starts the daemon again when it exits, and how the daemon asks for that restart.

import { LAUNCHD_LABEL } from "./cli";

export type Supervisor = { kind: "app"; pid: number } | { kind: "launchd"; target: string } | null;

/**
 * The daemon's supervisor: the app (HARNESS_SUPERVISOR_PID is its parent) or launchd (pid 1, with
 * XPC_SERVICE_NAME set to the label). Agents inherit both variables but not the parent, so the
 * parent has to be the supervisor itself. Null when run by hand.
 */
export function findSupervisor(env: NodeJS.ProcessEnv, ppid: number, uid: number): Supervisor {
  const appPid = Number(env.HARNESS_SUPERVISOR_PID) || null;
  if (appPid !== null && ppid === appPid) return { kind: "app", pid: appPid };
  if (env.XPC_SERVICE_NAME === LAUNCHD_LABEL && ppid === 1) return { kind: "launchd", target: `gui/${uid}/${LAUNCHD_LABEL}` };
  return null;
}

export interface RestartDeps {
  /** Run a command; resolves with its exit code (null when it couldn't run) */
  run: (cmd: string[]) => Promise<number | null>;
  /** The daemon's normal shutdown, after which it exits 0 */
  shutdown: (reason: string) => void;
  log: (msg: string) => void;
}

/**
 * Restart the daemon onto whatever its supervisor starts. The app starts its child again whenever
 * it exits. launchd's KeepAlive does too, except that a respawn isn't a demand: while the gui
 * domain is in on-demand-only mode (a logout that was cancelled, such as an interrupted update
 * restart, leaves it there) launchd holds it, and a service that exits stays down. So under launchd
 * the daemon has launchd restart it with `kickstart -k`, a demand it always serves: launchd sends
 * SIGTERM (the normal shutdown) and starts the job again. launchd does the restart itself, so its
 * launchctl going down with the daemon doesn't matter. If launchctl fails, the exit is left to
 * KeepAlive.
 */
export function restartThrough(supervisor: Exclude<Supervisor, null>, d: RestartDeps): void {
  if (supervisor.kind === "app") return d.shutdown("restart");
  d.log(`restarting through launchd (kickstart -k ${supervisor.target})`);
  void d.run(["/bin/launchctl", "kickstart", "-k", supervisor.target]).then((code) => {
    if (code === 0) return;
    d.log(`launchctl kickstart failed (${code ?? "didn't run"}); exiting for KeepAlive to restart the service`);
    d.shutdown("restart");
  });
}
