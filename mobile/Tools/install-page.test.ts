import { expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { betaManifest, carryBeta, features, manifest, page, privacy, readInfo, type ReleaseInfo } from "./install-page";

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
  // The app carries its own service: nobody is sent to install Bun or build from the repo.
  expect(p).not.toContain("bun.sh");
  expect(p).not.toContain("install-app");
  expect(p).toContain("Settings &rarr; Service");
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

const BETA: NonNullable<ReleaseInfo["iosBeta"]> = { url: "https://harness-install.vercel.app/HarnessBeta.ipa?a=1&b=2", version: "1.0.0", build: "202610021200", bytes: 13 * 1024 * 1024, builtAt: "2026-10-02" };
const withBeta = (r: ReleaseInfo = info({}, { testflightUrl: TF })): ReleaseInfo => ({ ...r, iosBeta: BETA });
const section = (p: string, cls: string) => p.match(new RegExp(`<section class="${cls}">[\\s\\S]*?</section>`))?.[0] ?? "";

test("without a beta the page has no beta card, CSS or manifest, the same with iosBeta null", () => {
  for (const r of [info({}, { testflightUrl: TF }), { ...info({}, { testflightUrl: TF }), iosBeta: null }]) {
    const p = page(r);
    expect(p).not.toContain("manifest-beta.plist");
    expect(p).not.toContain('class="beta"');
    expect(p).not.toContain("Harness Beta");
    expect(p).not.toContain("section.beta");
    expect(betaManifest(r)).toBeNull();
  }
  expect(page({ ...info(), iosBeta: null })).toBe(page(info()));
});

test("the committed page is what release.json generates, so a regeneration changes nothing else", () => {
  const dir = resolve(import.meta.dir, "..", "Install");
  const saved = JSON.parse(readFileSync(join(dir, "release.json"), "utf8")) as ReleaseInfo;
  expect(readFileSync(join(dir, "index.html"), "utf8")).toBe(page(saved));
  expect(readFileSync(join(dir, "manifest.plist"), "utf8")).toBe(manifest(saved));
  expect(existsSync(join(dir, "manifest-beta.plist"))).toBe(!!saved.iosBeta);
  if (saved.iosBeta) expect(readFileSync(join(dir, "manifest-beta.plist"), "utf8")).toBe(betaManifest(saved)!);
});

test("with a beta: a secondary card after the iPhone card installs it from its own manifest", () => {
  const p = withBeta();
  const html = page(p);
  const card = section(html, "beta");
  expect(card).toContain("Native iPhone app");
  expect(card).toContain('href="itms-services://?action=download-manifest&amp;url=https://harness-install.vercel.app/manifest-beta.plist"');
  expect(card).toContain('<a class="install secondary"');
  expect(card).toContain("SwiftUI");
  expect(card).toContain("beside the main app");
  expect(card).toContain("registered to Mark's Apple Developer team");
  expect(card).toContain("Enter manually");
  expect(card).toContain("13.0 MB");
  expect(card).toContain("(202610021200)");
  // The main app is untouched: still the only primary button, still TestFlight, same manifest.
  const [, href, label] = primaryButton(html) ?? [];
  expect(label).toBe("Get it on TestFlight");
  expect(href).toContain("testflight.apple.com");
  expect(html.match(/<a class="install"/g)?.length).toBe(1);
  expect(html).toContain("url=https://harness-install.vercel.app/manifest.plist");
  // Order: iPhone, beta, Mac (and on wide screens, the beta sits under the iPhone card).
  expect(html.indexOf("<h2>iPhone and iPad</h2>")).toBeLessThan(html.indexOf('class="beta"'));
  expect(html.indexOf('class="beta"')).toBeLessThan(html.indexOf("<h2>Mac (Apple silicon)</h2>"));
  expect(html).toContain(".installs section.beta { grid-column: 1; grid-row: 2; }");
  // Everything outside the card and its CSS is the page without a beta.
  const without = page({ ...p, iosBeta: null });
  expect(html.replace(`\n    ${card}\n`, "").replace(/\n  @media \(min-width: 760px\) \{ \.installs section\.beta[^\n]*\n  h2 \.tag[^\n]*\n/, "").replace("None of these builds contains", "Neither build contains")).toBe(without);
  expect(html).not.toMatch(/—/);
});

test("the beta manifest has its own bundle id, title, version and escaped IPA URL; the main one doesn't change", () => {
  const m = betaManifest(withBeta())!;
  expect(m).toContain("<key>bundle-identifier</key><string>com.markhuot.harness.dev</string>");
  expect(m).toContain("<key>title</key><string>Harness Beta</string>");
  expect(m).toContain("<string>https://harness-install.vercel.app/HarnessBeta.ipa?a=1&amp;b=2</string>");
  expect(m).not.toContain("releases/latest/download");
  expect(manifest(withBeta())).toBe(manifest(info({}, { testflightUrl: TF })));
});

test("beta values are escaped", () => {
  const card = section(page({ ...info(), iosBeta: { ...BETA, version: "<i>", build: '9"', builtAt: "a&b" } }), "beta");
  expect(card).toContain("Version &lt;i&gt; (9&quot;)");
  expect(card).toContain("a&amp;b");
  expect(card).not.toContain("<i>");
});

test("the footer's token note covers all three builds only when there's a beta", () => {
  expect(page(info())).toContain('<p class="foot">Neither build contains a token.');
  const p = page(withBeta());
  expect(p).toContain('<p class="foot">None of these builds contains a token.');
  expect(p).not.toContain("Neither build");
});

test("carryBeta: a release keeps the previous beta only while that exact IPA is still in Install/", () => {
  const release = info();
  const prev = withBeta(info());
  expect(carryBeta(release, prev, BETA.bytes).iosBeta).toEqual(BETA);
  expect(carryBeta(release, prev, BETA.bytes - 1).iosBeta).toBeNull(); // a different IPA is there
  expect(carryBeta(release, prev, null).iosBeta).toBeNull(); // no IPA to deploy
  expect(carryBeta(release, null, BETA.bytes).iosBeta).toBeNull();
  // Input that says what it wants wins: a new beta, or null to drop it.
  const next = { ...BETA, build: "202610030000" };
  expect(carryBeta({ ...release, iosBeta: next }, prev, BETA.bytes).iosBeta).toEqual(next);
  expect(carryBeta({ ...release, iosBeta: null }, prev, BETA.bytes).iosBeta).toBeNull();
});

test("the CLI reads release info from an argument or --from-json <file>", () => {
  const json = JSON.stringify(info());
  expect(readInfo([json]).tag).toBe("app-20260927.1530");
  expect(readInfo(["--from-json", "/x/release.json"], (f) => (f === "/x/release.json" ? json : "{}")).tag).toBe("app-20260927.1530");
  expect(() => readInfo(["--from-json"])).toThrow("needs a file path");
});
