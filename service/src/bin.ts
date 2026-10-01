// Entrypoint of the compiled service executable (service/scripts/compile.ts): one file that is
// both the daemon and the CLI, so Harness.app needs no bun.
//
//   harness-service daemon      run the service (what the app and the launchd plist start)
//   harness-service <args…>     the CLI (cli.ts), e.g. `harness-service service status --json`

if (process.argv[2] === "daemon") {
  await import("./daemon");
} else {
  const { Cli, defaultDeps } = await import("./cli");
  process.exit(await new Cli(defaultDeps()).run(process.argv.slice(2)));
}
