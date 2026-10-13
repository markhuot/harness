// `bun run test`: every package's tests (bun run --filter '*' test), then a summary of what
// skipped and why, so a test that skipped for want of Chrome or a LAN address is never silent.
//
//   bun scripts/test.ts [args for each package's test script]

import { useRealGit } from "../shared/src/testing/git-path";
import { formatSkips, summarizeSkips } from "../shared/src/testing/skip";

async function main(args: string[]): Promise<number> {
  useRealGit();
  const proc = Bun.spawn([process.execPath, "run", "--filter", "*", "test", ...args], { stdout: "pipe", stderr: "pipe", stdin: "inherit" });
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    for await (const chunk of stream) {
      output += Buffer.from(chunk).toString();
      sink.write(chunk);
    }
  };
  await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
  let code = await proc.exited;
  // The repo-root scripts (verify's path mapping) aren't a workspace, so they get their own run.
  if (!args.length) {
    const own = Bun.spawn([process.execPath, "test", "./scripts"], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
    code ||= await own.exited;
  }
  console.log(`\n${formatSkips(summarizeSkips(output))}`);
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
