import { expect, test } from "bun:test";
import appJson from "../app.json";

// The app talks plain http to the harness service on a Tailscale IP (100.x) or a LAN/custom host.
// iOS ignores NSAllowsArbitraryLoads whenever NSAllowsLocalNetworking (or the ...InWebContent /
// ...ForMedia keys) is also present, and "local networking" doesn't cover a 100.x address, so
// pairing over Tailscale failed with NSURLErrorDomain -1022 while 127.0.0.1 in the simulator worked.
const ats = (appJson as any).expo.ios.infoPlist.NSAppTransportSecurity as Record<string, unknown>;

test("ATS allows arbitrary loads so http to a Tailscale IP works", () => {
  expect(ats.NSAllowsArbitraryLoads).toBe(true);
});

test("no ATS key that makes iOS ignore NSAllowsArbitraryLoads", () => {
  for (const key of ["NSAllowsLocalNetworking", "NSAllowsArbitraryLoadsInWebContent", "NSAllowsArbitraryLoadsForMedia"]) {
    expect(Object.keys(ats)).not.toContain(key);
  }
});
