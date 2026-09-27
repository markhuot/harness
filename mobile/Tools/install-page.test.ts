import { expect, test } from "bun:test";
import { manifest, page, type ReleaseInfo } from "./install-page";

const info = (over: Partial<ReleaseInfo["mac"]> = {}): ReleaseInfo => ({
  site: "https://harness-install.vercel.app",
  tag: "app-20260927.1530",
  releaseUrl: "https://github.com/markhuot/harness/releases/tag/app-20260927.1530",
  date: "2026-09-27",
  ios: { url: "https://github.com/markhuot/harness/releases/latest/download/Harness.ipa?x=1&y=2", version: "1.0.0", build: "202609271530", bytes: 10 * 1024 * 1024 },
  mac: { url: "https://github.com/markhuot/harness/releases/latest/download/Harness-mac.zip", version: "0.1.0", bytes: 120 * 1024 * 1024, notarized: false, ...over },
});

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
  expect(p).toContain("right-click Harness.app");
  expect(page(info({ notarized: true }))).not.toContain("right-click");
  expect(p).not.toMatch(/—/); // house style: no em dashes in page copy
});

test("page without a Mac build yet: no download link, the iPhone install still works", () => {
  const p = page({ ...info(), mac: null });
  expect(p).not.toContain("Harness-mac.zip");
  expect(p).toContain("still being prepared");
  expect(p).toContain("itms-services://");
});
