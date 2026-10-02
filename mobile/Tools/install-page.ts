// Writes Install/index.html, Install/privacy.html and Install/manifest.plist for a release. The page
// links the iPhone and iPad build (TestFlight when there's a public link, else OTA via itms-services +
// manifest.plist, which must be served from HTTPS as text/xml) and the Mac build; both files live on
// the GitHub release. Screenshots come from Install/img/ (see features below). No secrets go in any file.
//
// The page can also carry the native SwiftUI app (ios/) as a beta: its IPA is uploaded with the site
// itself (Install/HarnessBeta.ipa, gitignored) by `bun ios/Tools/build.ts publish-beta`, outside
// tagged releases, and installs from manifest-beta.plist. Every run saves its input to
// Install/release.json, so the next run (a release or a new beta) starts from what's live.
//
//   bun Tools/install-page.ts '<json>'              (see ReleaseInfo)
//   bun Tools/install-page.ts --from-json <file>    (the same, read from a file)
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface ReleaseInfo {
  site: string;
  tag: string;
  releaseUrl: string;
  date: string;
  ios: {
    url: string;
    version: string;
    build: string;
    bytes: number;
    /** TestFlight public link; null (or missing) while there isn't one, so the page offers the development build */
    testflightUrl?: string | null;
  };
  /** null while the Mac build isn't on the release yet */
  mac: { url: string; version: string; bytes: number; notarized: boolean } | null;
  /** The native app's development-signed beta (BETA_BUNDLE_ID), hosted on the site; absent when there isn't one */
  iosBeta?: { url: string; version: string; build: string; bytes: number; builtAt: string } | null;
}

/** The beta installs beside the main app, so it has its own id (the native Debug id) and name. */
export const BETA_BUNDLE_ID = "com.markhuot.harness.dev";
export const BETA_TITLE = "Harness Beta";
export const BETA_IPA = "HarnessBeta.ipa";
export const BETA_MANIFEST = "manifest-beta.plist";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;

export const CONTACT = "mark@markhuot.com";

/** The Mac app carries its own service (service/scripts/compile.ts), so the download is all it takes. */
export const MAC_SERVICE_NOTE = "The app includes the service that runs your agents, so you don't need Bun or a copy of the Harness source.";

export function manifest(r: ReleaseInfo): string {
  return plist(r.site, { url: r.ios.url, version: r.ios.version, bundleId: "com.markhuot.harness", title: "Harness" });
}

/** The beta's OTA manifest, or null when the page has no beta. */
export function betaManifest(r: ReleaseInfo): string | null {
  return r.iosBeta ? plist(r.site, { url: r.iosBeta.url, version: r.iosBeta.version, bundleId: BETA_BUNDLE_ID, title: BETA_TITLE }) : null;
}

function plist(site: string, app: { url: string; version: string; bundleId: string; title: string }): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>items</key>
	<array>
		<dict>
			<key>assets</key>
			<array>
				<dict>
					<key>kind</key><string>software-package</string>
					<key>url</key><string>${esc(app.url)}</string>
				</dict>
				<dict>
					<key>kind</key><string>display-image</string>
					<key>url</key><string>${esc(site)}/icon57.png</string>
				</dict>
				<dict>
					<key>kind</key><string>full-size-image</string>
					<key>url</key><string>${esc(site)}/icon512.png</string>
				</dict>
			</array>
			<key>metadata</key>
			<dict>
				<key>bundle-identifier</key><string>${esc(app.bundleId)}</string>
				<key>bundle-version</key><string>${esc(app.version)}</string>
				<key>kind</key><string>software</string>
				<key>title</key><string>${esc(app.title)}</string>
			</dict>
		</dict>
	</array>
</dict>
</plist>
`;
}

/**
 * The bento grid. Each image is img/<img>-light.webp and img/<img>-dark.webp (1x captures of the
 * Mac app against app/scripts/mock-service.ts or the git plugin's temp daemon, and sim-check shots
 * of the iPhone app, so they only show mock data). `size` picks the tile's span on wide screens.
 */
export const features: { img: string; w: number; h: number; size: "hero" | "full" | "tall" | "wide" | "small"; title: string; body: string }[] = [
  {
    img: "board",
    w: 1440,
    h: 900,
    size: "hero",
    title: "Every agent session is a ticket",
    body: "Each job you hand an agent gets a card with a key like NYTIMES-4. The board shows what's in planning, what's running, what's waiting on you and what's ready for review, across every project on your Mac.",
  },
  {
    img: "review",
    w: 482,
    h: 800,
    size: "tall",
    title: "Two reviews before anything lands",
    body: "When an agent submits its work, a separate reviewer agent checks it, and then you give your own review. Approving can merge the branch, open a GitHub pull request, or follow instructions you write.",
  },
  {
    img: "changes",
    w: 1208,
    h: 800,
    size: "full",
    title: "A worktree and a branch for each ticket",
    body: "In a git project, each ticket works in its own worktree on its own branch, so several agents can work in one repo at the same time. The Changes tab shows everything a ticket changed against its base branch, uncommitted files included.",
  },
  {
    img: "iphone",
    w: 600,
    h: 1304,
    size: "tall",
    title: "The same board on iPhone and iPad",
    body: "Answer an agent's question, approve a command, read the transcript or approve finished work from your phone. The app connects straight to your Mac over Tailscale.",
  },
  {
    img: "inbox",
    w: 1208,
    h: 500,
    size: "wide",
    title: "Watchers turn a feed into tickets",
    body: "A watcher is any shell command that prints text (a Jira or Sentry poller, for example) plus a prompt that says what you want done with it. A triage agent reads each new item and either opens a ticket in the right project or declines it, and the Inbox shows every decision.",
  },
  {
    img: "conductor",
    w: 482,
    h: 800,
    size: "small",
    title: "Big goals split into child tickets",
    body: "A conductor ticket breaks a goal into child tickets with dependencies and starts each one when the work it waits on is done. The children merge into the conductor's branch, so the whole goal lands together.",
  },
  {
    img: "approval",
    w: 482,
    h: 700,
    size: "small",
    title: "You approve the risky commands",
    body: "Agents edit files in their own workspace freely. A command the permission rules don't allow (installing a package, say) stops the ticket until you allow it once, allow it for the ticket, or deny it with a note.",
  },
];

const css = `
  :root {
    --font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Inter", "Segoe UI", system-ui, sans-serif;
    --mono: "SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace;
    --bg: #fbfbfc;
    --bg-elev: #ffffff;
    --bg-sunken: #f5f5f7;
    --border: #e4e4e8;
    --text: #1a1b1f;
    --text-2: #55575f;
    --text-3: #8a8c94;
    --accent: #5e6ad2;
    --accent-hover: #515cc4;
    --accent-soft: rgba(94, 106, 210, 0.12);
    --accent-text: #4b56c0;
    --shadow: 0 1px 2px rgba(15, 17, 22, 0.05), 0 4px 12px rgba(15, 17, 22, 0.05);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #111214;
      --bg-elev: #1a1b1e;
      --bg-sunken: #0e0f11;
      --border: #26272c;
      --text: #e8e8eb;
      --text-2: #a4a6ae;
      --text-3: #6f717a;
      --accent: #6e79d6;
      --accent-hover: #7f89e0;
      --accent-soft: rgba(110, 121, 214, 0.18);
      --accent-text: #a3abf0;
      --shadow: 0 1px 2px rgba(0, 0, 0, 0.35), 0 4px 14px rgba(0, 0, 0, 0.25);
    }
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    min-height: 100svh;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.5 var(--font);
    -webkit-font-smoothing: antialiased;
    display: flex;
    justify-content: center;
    padding:
      calc(24px + env(safe-area-inset-top))
      calc(16px + env(safe-area-inset-right))
      calc(24px + env(safe-area-inset-bottom))
      calc(16px + env(safe-area-inset-left));
  }
  .stack { width: 100%; max-width: 1080px; display: flex; flex-direction: column; gap: 16px; }
  .stack.narrow { max-width: 680px; }
  section {
    width: 100%;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    padding: 28px 22px 22px;
  }
  header { display: flex; align-items: center; gap: 14px; }
  header img { width: 64px; height: 64px; border-radius: 15px; flex: none; }
  h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
  .tag {
    display: inline-block;
    margin-top: 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent-text);
    background: var(--accent-soft);
    padding: 2px 8px;
    border-radius: 999px;
  }
  p { margin: 18px 0 0; color: var(--text-2); }
  .intro p { max-width: 68ch; }
  a { color: var(--accent-text); }
  a.install {
    display: block;
    margin-top: 22px;
    padding: 14px 16px;
    border-radius: 10px;
    background: var(--accent);
    color: #fff;
    text-align: center;
    text-decoration: none;
    font-size: 16px;
    font-weight: 600;
    -webkit-tap-highlight-color: transparent;
  }
  a.install:active, a.install:hover { background: var(--accent-hover); }
  a.install.secondary { background: var(--bg-sunken); color: var(--text); border: 1px solid var(--border); }
  ol {
    margin: 22px 0 0;
    padding: 16px 16px 16px 34px;
    background: var(--bg-sunken);
    border: 1px solid var(--border);
    border-radius: 10px;
    color: var(--text-2);
    font-size: 13.5px;
  }
  ol li + li { margin-top: 8px; }
  strong { color: var(--text); font-weight: 600; }
  code {
    font: 12px var(--mono);
    color: var(--text);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    padding: 1px 5px;
    border-radius: 5px;
    word-break: break-word;
  }
  .foot { margin-top: 16px; font-size: 12px; color: var(--text-3); }
  .foot a { color: inherit; }
  h2 { margin: 0; font-size: 17px; font-weight: 650; }
  .meta { margin-top: 10px; font: 12px var(--mono); color: var(--text-3); }
  .alt { margin-top: 14px; font-size: 13px; color: var(--text-3); }
  .kicker { margin: 8px 2px 0; font-size: 12px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--text-3); }

  /* Bento grid: one column on a phone, mixed tile sizes on wider screens. */
  .bento { display: grid; grid-template-columns: 1fr; gap: 16px; }
  .tile {
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 14px;
    box-shadow: var(--shadow);
    overflow: hidden;
    min-width: 0;
  }
  .tile .copy { padding: 20px 22px 18px; }
  .tile h3 { margin: 0; font-size: 15.5px; font-weight: 650; letter-spacing: -0.005em; }
  .tile p { margin: 6px 0 0; font-size: 13.5px; }
  .tile .shot {
    flex: 1;
    margin: 0 0 0 22px;
    border-top: 1px solid var(--border);
    border-left: 1px solid var(--border);
    border-top-left-radius: 10px;
    overflow: hidden;
    background: var(--bg-sunken);
    min-height: 220px;
    max-height: 420px;
  }
  .tile .shot img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: left top; }
  .tile.phone .shot { margin: 0 auto; width: 300px; max-width: calc(100% - 44px); max-height: 480px; border: 1px solid var(--border); border-bottom: 0; border-radius: 26px 26px 0 0; }
  .tile.phone .shot img { object-position: center top; }
  @media (min-width: 760px) {
    .bento { grid-template-columns: repeat(6, 1fr); grid-auto-flow: dense; }
    .tile.hero { grid-column: span 4; grid-row: span 2; }
    .tile.tall { grid-column: span 2; grid-row: span 2; }
    .tile.full { grid-column: span 6; }
    .tile.wide { grid-column: span 4; }
    .tile.small { grid-column: span 2; }
    .tile .shot { max-height: none; }
    .tile.small .shot, .tile.wide .shot { height: 260px; flex: none; margin-top: auto; }
    .tile.full .shot { height: 340px; flex: none; }
    .tile.phone .shot { max-height: none; }
  }

  .steps { counter-reset: step; list-style: none; padding: 0; background: none; border: 0; margin: 20px 0 0; font-size: 14px; }
  .steps > li { counter-increment: step; position: relative; padding: 0 0 0 40px; }
  .steps > li + li { margin-top: 18px; }
  .steps > li::before {
    content: counter(step);
    position: absolute;
    left: 0;
    top: 0;
    width: 26px;
    height: 26px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: 13px;
    font-weight: 650;
    display: grid;
    place-items: center;
  }
  .steps p { margin: 4px 0 0; }
  .installs { display: grid; grid-template-columns: 1fr; gap: 16px; }
  @media (min-width: 760px) { .installs { grid-template-columns: 1fr 1fr; } }
  .installs section { display: flex; flex-direction: column; }
  .installs .meta { margin-top: auto; padding-top: 14px; }
  section.prose h2 { margin-top: 26px; }
  section.prose h2:first-of-type { margin-top: 22px; }
  section.prose p { margin-top: 8px; }
`;

/** Only on a page with the beta card, which sits under the iPhone card in the left column. */
const betaCss = `
  @media (min-width: 760px) { .installs section.beta { grid-column: 1; grid-row: 2; } }
  h2 .tag { margin: 0 0 0 6px; vertical-align: 2px; }
`;

const head = (title: string, extraCss = "") => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#fbfbfc" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#111214" media="(prefers-color-scheme: dark)">
<title>${esc(title)}</title>
<link rel="apple-touch-icon" href="icon512.png">
<link rel="icon" href="icon57.png">
<style>${css}${extraCss}</style>
</head>`;

function tile(f: (typeof features)[number]): string {
  return `      <article class="tile ${f.size}${f.img === "iphone" ? " phone" : ""}">
        <div class="copy">
          <h3>${esc(f.title)}</h3>
          <p>${esc(f.body)}</p>
        </div>
        <div class="shot">
          <picture>
            <source srcset="img/${f.img}-dark.webp" media="(prefers-color-scheme: dark)">
            <img src="img/${f.img}-light.webp" width="${f.w}" height="${f.h}" loading="lazy" alt="">
          </picture>
        </div>
      </article>`;
}

function iosSection(r: ReleaseInfo): string {
  const itms = `itms-services://?action=download-manifest&url=${r.site}/manifest.plist`;
  const meta = `<div class="meta">Version ${esc(r.ios.version)} (${esc(r.ios.build)}) &middot; ${mb(r.ios.bytes)} &middot; ${esc(r.date)}</div>`;
  const tf = r.ios.testflightUrl;
  if (tf) {
    return `    <section>
      <h2>iPhone and iPad</h2>
      <p>The iPhone and iPad app is in beta on TestFlight, Apple's app for trying apps before they're in the App Store.</p>
      <a class="install" href="${esc(tf)}">Get it on TestFlight</a>
      <ol>
        <li>Install <strong>TestFlight</strong> from the App Store.</li>
        <li>Open this page on the iPhone or iPad and tap <strong>Get it on TestFlight</strong>.</li>
        <li>In TestFlight, tap <strong>Accept</strong>, then <strong>Install</strong>.</li>
      </ol>
      <p class="alt">Is your device registered to Mark's developer team? <a href="${esc(itms)}">Install the development build</a> instead.</p>
      ${meta}
    </section>`;
  }
  return `    <section>
      <h2>iPhone and iPad</h2>
      <p>This is a development build, so it only installs on iPhones and iPads registered to Mark's Apple Developer team. A newly registered device needs a new release before it can install.</p>
      <a class="install" href="${esc(itms)}">Install on iPhone or iPad</a>
      <ol>
        <li>Open this page in Safari on the iPhone or iPad and tap <strong>Install on iPhone or iPad</strong>.</li>
        <li>If iOS says the developer isn't trusted, open Settings &rarr; General &rarr; VPN &amp; Device Management and trust <code>Apple Development: Mark Huot</code>.</li>
      </ol>
      ${meta}
    </section>`;
}

/** The native beta, under the main iPhone card; "" without one, so the page is as it was. */
function betaSection(r: ReleaseInfo): string {
  const b = r.iosBeta;
  if (!b) return "";
  const itms = `itms-services://?action=download-manifest&url=${r.site}/${BETA_MANIFEST}`;
  return `
    <section class="beta">
      <h2>Native iPhone app <span class="tag">Beta</span></h2>
      <p>An early native SwiftUI rebuild of the iPhone and iPad app. It installs beside the main app as ${esc(BETA_TITLE)}, so you can try it and keep the main app.</p>
      <a class="install secondary" href="${esc(itms)}">Install ${esc(BETA_TITLE)}</a>
      <p class="alt">It's a development build, so it only installs on devices registered to Mark's Apple Developer team. Both apps open pairing links, so the QR code may open the main app instead. Typing the URL and token under <strong>Enter manually</strong> always works.</p>
      <div class="meta">Version ${esc(b.version)} (${esc(b.build)}) &middot; ${mb(b.bytes)} &middot; ${esc(b.builtAt)}</div>
    </section>
`;
}

function macSection(r: ReleaseInfo): string {
  if (!r.mac) {
    return `    <section>
      <h2>Mac (Apple silicon)</h2>
      <p>The signed Mac build for this release is still being prepared. Check back shortly.</p>
    </section>`;
  }
  const openNote = r.mac.notarized
    ? "The download is signed and notarized, so macOS opens it without a warning."
    : "The download is signed with Mark's Developer ID but not notarized yet, so macOS blocks the first launch. Open it once, then go to System Settings → Privacy & Security and click Open Anyway.";
  return `    <section>
      <h2>Mac (Apple silicon)</h2>
      <p>${esc(MAC_SERVICE_NOTE)}</p>
      <a class="install secondary" href="${esc(r.mac.url)}">Download for Mac</a>
      <p class="alt">${esc(openNote)}</p>
      ${`<div class="meta">Version ${esc(r.mac.version)} &middot; ${mb(r.mac.bytes)} &middot; ${esc(r.date)}</div>`}
    </section>`;
}

export function page(r: ReleaseInfo): string {
  const phoneStep = r.ios.testflightUrl ? "Get the iPhone app from TestFlight (below)" : "Install the iPhone app (below)";
  return `${head("Install Harness", r.iosBeta ? betaCss : "")}
<body>
  <div class="stack">
    <section class="intro">
      <header>
        <img src="icon512.png" alt="">
        <div>
          <h1>Harness</h1>
          <span class="tag">Release ${esc(r.tag)}</span>
        </div>
      </header>
      <p>Harness runs AI coding agents on your Mac and puts each one on a kanban board as a ticket. You describe the work and the agent does it on its own branch, and nothing merges until you've reviewed it.</p>
      <p>The iPhone and iPad app shows the same board, so you can answer an agent's question or approve its work when you're away from your desk.</p>
    </section>

    <div class="kicker">What it does</div>
    <div class="bento">
${features.map(tile).join("\n")}
    </div>

    <section id="getting-started">
      <h2>Getting started</h2>
      <ol class="steps">
        <li><strong>Get the Mac ready.</strong>
          <p>Harness runs on an Apple silicon Mac with <a href="https://git-scm.com">git</a>. Agents run through the <a href="https://docs.anthropic.com/en/docs/claude-code">Claude Code CLI</a>, signed in to your Claude team plan with <code>claude auth login</code> (an Anthropic API key in Settings works too). To use the iPhone app, install <a href="https://tailscale.com/download">Tailscale</a> on the Mac.</p></li>
        <li><strong>Install the Mac app.</strong>
          <p>Download Harness for Mac (below), unzip it, and drag Harness into your Applications folder. When you open it, it starts the background service that runs your agents. By default the service stops when you quit the app, so to keep agents running after you quit, open Settings &rarr; Service and click <strong>Install</strong> next to Start at login. macOS then starts the service whenever you log in.</p></li>
        <li><strong>Add a project.</strong>
          <p>Click <strong>+</strong> next to Projects in the sidebar and pick a folder you work in. A git repository works best, since each ticket then gets its own worktree and branch.</p></li>
        <li><strong>Make a ticket.</strong>
          <p>Press <strong>⌘N</strong>, pick the project and describe what you want done. <strong>⌘↩</strong> starts the agent right away, and <strong>⇧⌘↩</strong> has it write a plan for you to approve first.</p></li>
        <li><strong>Pair your iPhone or iPad.</strong>
          <p>${phoneStep}. Sign in to Tailscale on the phone with the same account as the Mac. Then open Harness &rarr; Settings &rarr; Network on the Mac, choose <strong>Tailscale</strong>, and scan the <strong>Pair a phone</strong> QR code with the phone's camera.</p></li>
      </ol>
    </section>

    <div class="installs">
${iosSection(r)}
${betaSection(r)}
${macSection(r)}
    </div>

    <p class="foot">Neither build contains a token. Pairing hands the device one, and it's kept in that device's Keychain. <a href="${esc(r.releaseUrl)}">Release notes and files</a> &middot; <a href="privacy.html">Privacy</a></p>
  </div>
</body>
</html>
`;
}

export function privacy(): string {
  return `${head("Harness privacy policy")}
<body>
  <div class="stack narrow">
    <section class="prose">
      <header>
        <img src="icon512.png" alt="">
        <div>
          <h1>Privacy policy</h1>
          <span class="tag">Harness for iPhone and iPad</span>
        </div>
      </header>
      <p>Harness for iPhone and iPad has no accounts, analytics, ads or tracking, and there's no Harness server on the internet. The app talks only to your own Mac running the Harness app, over your local network or Tailscale.</p>

      <h2>What stays on your device</h2>
      <p>When you pair the app with your Mac, it stores the pairing token in your device's Keychain. The app sends that token only to your Mac, which uses it to check that the device is allowed to connect.</p>

      <h2>The camera</h2>
      <p>The app uses the camera only to scan the pairing QR code your Mac shows. Nothing the camera sees is recorded or uploaded.</p>

      <h2>Your tickets and code</h2>
      <p>Tickets, transcripts and project files live on your Mac. The app loads them from your Mac when you open them. The agents on your Mac send prompts and code to the model provider you set up there (Anthropic, for Claude Code and the Anthropic API) under that provider's terms. The iPhone and iPad app doesn't contact those providers.</p>

      <h2>TestFlight</h2>
      <p>If you install the app through TestFlight, Apple collects crash reports and any feedback you send under Apple's TestFlight terms, and shares them with the developer.</p>

      <h2>Questions</h2>
      <p>Email Mark Huot at <a href="mailto:${CONTACT}">${CONTACT}</a>.</p>
      <p class="foot">Last updated September 30, 2026. <a href="index.html">Install Harness</a></p>
    </section>
  </div>
</body>
</html>
`;
}

/** The CLI's input: a JSON argument, or `--from-json <file>`. */
export function readInfo(argv: string[], read: (file: string) => string = (f) => readFileSync(f, "utf8")): ReleaseInfo {
  const i = argv.indexOf("--from-json");
  if (i >= 0) {
    const file = argv[i + 1];
    if (!file) throw new Error("--from-json needs a file path");
    return JSON.parse(read(file)) as ReleaseInfo;
  }
  return JSON.parse(argv[0] ?? "{}") as ReleaseInfo;
}

/**
 * A release doesn't know about the beta, so it keeps the previous page's beta, but only while that
 * IPA is still in Install/ with the same size: it's deployed from there, and a card whose IPA isn't
 * deployed would fail to install. `iosBeta: null` drops it on purpose.
 */
export function carryBeta(info: ReleaseInfo, previous: ReleaseInfo | null, betaIpaBytes: number | null): ReleaseInfo {
  if (info.iosBeta !== undefined) return info;
  const beta = previous?.iosBeta;
  return { ...info, iosBeta: beta && beta.bytes === betaIpaBytes ? beta : null };
}

if (import.meta.main) {
  const dir = resolve(import.meta.dir, "..", "Install");
  const saved = join(dir, "release.json");
  const ipa = join(dir, BETA_IPA);
  const info = carryBeta(
    readInfo(process.argv.slice(2)),
    existsSync(saved) ? (JSON.parse(readFileSync(saved, "utf8")) as ReleaseInfo) : null,
    existsSync(ipa) ? statSync(ipa).size : null,
  );
  writeFileSync(join(dir, "index.html"), page(info));
  writeFileSync(join(dir, "privacy.html"), privacy());
  writeFileSync(join(dir, "manifest.plist"), manifest(info));
  const beta = betaManifest(info);
  if (beta) writeFileSync(join(dir, BETA_MANIFEST), beta);
  else rmSync(join(dir, BETA_MANIFEST), { force: true });
  writeFileSync(saved, `${JSON.stringify(info, null, 2)}\n`);
  console.log(`wrote ${dir}/index.html, privacy.html, manifest.plist${beta ? ` and ${BETA_MANIFEST}` : ""} for ${info.tag}`);
}
