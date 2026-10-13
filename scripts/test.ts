// `bun run test`: every package's tests (bun run --filter '*' test), then a summary of what
// skipped and why, so a test that skipped for want of Chrome or a LAN address is never silent.
//
//   bun scripts/test.ts [args for each package's test script]

import { formatSkips, summarizeSkips } from "../shared/src/testing/skip";

async function main(args: string[]): Promise<number> {
  const proc = Bun.spawn([process.execPath, "run", "--filter", "*", "test", ...args], { stdout: "pipe", stderr: "pipe", stdin: "inherit" });
  let output = "";
  const pump = async (stream: ReadableStream<Uint8Array>, sink: NodeJS.WriteStream) => {
    for await (const chunk of stream) {
      output += Buffer.from(chunk).toString();
      sink.write(chunk);
    }
  };
  await Promise.all([pump(proc.stdout, process.stdout), pump(proc.stderr, process.stderr)]);
  const code = await proc.exited;
  console.log(`\n${formatSkips(summarizeSkips(output))}`);
  return code;
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
