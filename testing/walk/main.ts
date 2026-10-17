// The journey process: started by walk/run.ts inside both simulator locks. Kills what it started on
// SIGINT and SIGTERM as well as on the way out of a failed or finished run.

import { join } from "node:path";
import { killRecords, RunFile } from "../lib/procs";
import { runSteps } from "./journey";

const arg = (name: string) => {
  const v = process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (!v) throw new Error(`walk/main.ts needs --${name}=`);
  return v;
};
const env = (name: string) => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set: walk/main.ts runs under walk/run.ts, inside the simulator locks`);
  return v;
};

const runDir = arg("run-dir");
const runs = new RunFile(join(runDir, `${process.pid}.pids`));
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void killRecords(runs.records()).finally(() => process.exit(130));
  });
}

try {
  await runSteps(
    {
      out: arg("out"),
      macUserData: join(runDir, `profile-${process.pid}`),
      phones: [
        { name: "iPhone", udid: env("WALK_IPHONE_UDID") },
        { name: "iPad", udid: env("WALK_IPAD_UDID") },
      ],
    },
    runs,
    { app: arg("app") },
  );
  runs.remove();
  process.exit(0);
} catch {
  await killRecords(runs.records());
  runs.remove();
  process.exit(1);
}
