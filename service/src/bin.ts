// Entrypoint of the compiled service executable (service/scripts/compile.ts): one file that is
// both the daemon and the CLI, so Harness.app needs no bun.
//
//   harness-service daemon      run the service (what the app and the launchd plist start)
//   harness-service browser-script <file>   run a browser_run script (the service starts it)
//   harness-service <args…>     the CLI (cli.ts), e.g. `harness-service service status --json`

export {};

if (process.argv[2] === "daemon") {
  await import("./daemon");
} else if (process.argv[2] === "browser-script") {
  // A browser_run script's process (tools/browser-run.ts).
  await import("./browser/script-child");
} else {
  const { Cli, defaultDeps } = await import("./cli");
  process.exit(await new Cli(defaultDeps()).run(process.argv.slice(2)));
}
