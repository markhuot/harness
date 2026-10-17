import { watcher } from "./build";
import { minutesAgo, minutesFromNow } from "./time";

export const watchers = [
  watcher({ name: "jira", command: "watch-jira", args: ["--project", "FOO"], intervalSec: 300, live: { state: "waiting", since: minutesAgo(30), nextRunAt: minutesFromNow(1), failures: 0 } }),
  watcher({ name: "github", command: "watch-prs", mode: "loop", enabled: false, lastRunAt: null }),
  watcher({ name: "sentry", command: "watch-sentry", lastError: "401 from the Sentry API", live: { state: "stopped", since: minutesAgo(90), nextRunAt: null, failures: 3 } }),
];
