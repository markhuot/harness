import { expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { features, manifest, page, privacy, readInfo, type ReleaseInfo } from "./install-page";

const info = (over: Partial<ReleaseInfo["mac"]> = {}, ios: Partial<ReleaseInfo["ios"]> = {}): ReleaseInfo => ({
  site: "https://harness-install.vercel.app",
  tag: "app-20260927.1530",
  releaseUrl: "https://github.com/markhuot/harness/releases/tag/app-20260927.1530",
  date: "2026-09-27",
  ios: { url: "https://github.com/markhuot/harness/releases/latest/download/Harness.ipa?x=1&y=2", version: "1.0.0", build: "202609271530", bytes: 10 * 1024 * 1024, ...ios },
  mac: { url: "https://github.com/markhuot/harness/releases/latest/download/Harness-mac.zip", version: "0.1.0", bytes: 120 * 1024 * 1024, notarized: false, ...over },
});
const TF = "https://testflight.apple.com/join/AbC123?x=1&y=<2>";
const primaryButton = (p: string) => p.match(/<a class="install" href="([^"]*)">([^<]+)<\/a>/);

test("manifest points the installer at the IPA URL, XML-escaped, with the bundle id", () => {
  const m = manifest(info());
  expect(m).toContain("<string>https://github.com/markhuot/harness/releases/latest/download/Harness.ipa?x=1&amp;y=2</string>");
  expect(m).not.toContain("x=1&y=2");
  expect(m).toContain("<string>com.markhuot.harness</string>");
  expect(m).toContain("<string>https://harness-install.vercel.app/icon512.png</string>");
});

test("page: itms-services link to the manifest on the site, Mac download, sizes, open instructions by notarization", () => {
  const p = page(info());
  expect(p).toContain('href="itms-services://?action=download-manifest&amp;url=https://harness-install.vercel.app/manifest.plist"');
  expect(p).toContain('href="https://github.com/markhuot/harness/releases/latest/download/Harness-mac.zip"');
  expect(p).toContain("10.0 MB");
  expect(p).toContain("120.0 MB");
  expect(p).toContain("Privacy &amp; Security");
  expect(p).toContain("Open Anyway");
  expect(p).not.toContain("right-click"); // right-click → Open no longer bypasses Gatekeeper on macOS 15+
  const notarized = page(info({ notarized: true }));
  expect(notarized).not.toContain("Open Anyway");
  expect(notarized).toContain("signed and notarized");
});

test("house style: no em dashes in either page's copy", () => {
  for (const p of [page(info()), page(info({}, { testflightUrl: TF })), page({ ...info(), mac: null }), privacy()]) expect(p).not.toMatch(/—/);
});

test("without a TestFlight link: the development build is the main button, and its steps name it", () => {
  for (const p of [page(info()), page(info({}, { testflightUrl: null }))]) {
    const [, href, label] = primaryButton(p) ?? [];
    expect(href).toStartWith("itms-services://");
    expect(label).toBe("Install on iPhone or iPad");
    expect(p).toContain(`tap <strong>${label}</strong>`);
    expect(p).toContain("VPN &amp; Device Management");
    expect(p).not.toContain("testflight");
    expect(p).not.toContain("TestFlight");
  }
});

test("with a TestFlight link: it's the main button (escaped), its steps name it, and the development build is a secondary link", () => {
  const p = page(info({}, { testflightUrl: TF }));
  const [, href, label] = primaryButton(p) ?? [];
  expect(href).toBe("https://testflight.apple.com/join/AbC123?x=1&amp;y=&lt;2&gt;");
  expect(p).not.toContain("y=<2>");
  expect(label).toBe("Get it on TestFlight");
  expect(p).toContain(`tap <strong>${label}</strong>`);
  expect(p).toContain("<strong>Accept</strong>");
  // Only one primary button; the itms-services build moves to a plain link.
  expect(p.match(/<a class="install"/g)?.length).toBe(1);
  expect(p).toMatch(/<p class="alt">[^<]*<a href="itms-services:\/\/\?action=download-manifest&amp;url=https:\/\/harness-install\.vercel\.app\/manifest\.plist">/);
  expect(p).not.toContain("VPN &amp; Device Management");
  // Getting started points the phone step at TestFlight too.
  expect(p).toContain("from TestFlight (below)");
  expect(page(info())).not.toContain("from TestFlight (below)");
});

test("page without a Mac build yet: no download link, the iPhone install still works either way", () => {
  for (const testflightUrl of [null, TF]) {
    const p = page({ ...info({}, { testflightUrl }), mac: null });
    expect(p).not.toContain("Harness-mac.zip");
    expect(p).not.toContain("Download for Mac");
    expect(p).toContain("still being prepared");
    expect(p).toContain("itms-services://");
  }
});

test("release values are escaped", () => {
  const p = page({ ...info({ version: '1"<b>' }), tag: "app-<x>", date: "2026&09" });
  expect(p).toContain("Release app-&lt;x&gt;");
  expect(p).toContain("Version 1&quot;&lt;b&gt;");
  expect(p).toContain("2026&amp;09");
  expect(p).not.toContain("<b>");
});

test("every bento image the page references exists in Install/img, light and dark, and stays small", () => {
  const dir = resolve(import.meta.dir, "..", "Install");
  const p = page(info());
  const refs = [...p.matchAll(/(?:src|srcset)="(img\/[^"]+)"/g)].map((m) => m[1]!);
  expect(refs.length).toBe(features.length * 2);
  for (const f of features) {
    expect(refs).toContain(`img/${f.img}-light.webp`);
    expect(refs).toContain(`img/${f.img}-dark.webp`);
  }
  let total = 0;
  for (const ref of refs) {
    const file = join(dir, ref);
    expect(existsSync(file)).toBe(true);
    total += statSync(file).size;
  }
  expect(total).toBeLessThan(3 * 1024 * 1024);
});

test("the footer links the privacy policy, which has the contact address and links back", () => {
  expect(page(info())).toContain('<a href="privacy.html">Privacy</a>');
  const pr = privacy();
  expect(pr).toContain('href="mailto:mark@markhuot.com"');
  expect(pr).toContain('href="index.html"');
});

test("the CLI reads release info from an argument or --from-json <file>", () => {
  const json = JSON.stringify(info());
  expect(readInfo([json]).tag).toBe("app-20260927.1530");
  expect(readInfo(["--from-json", "/x/release.json"], (f) => (f === "/x/release.json" ? json : "{}")).tag).toBe("app-20260927.1530");
  expect(() => readInfo(["--from-json"])).toThrow("needs a file path");
});
