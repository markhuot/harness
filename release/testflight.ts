// TestFlight distribution through the App Store Connect API. publish-install.sh uploads the build
// (xcodebuild -exportArchive with ExportOptions-testflight.plist); this script then waits for App
// Store Connect to finish processing it, adds it to the external "Public" beta group (created with
// a public link the first time), submits it for Beta App Review and prints the group's public link.
//
//   bun Tools/testflight.ts setup                 fill in the app's Test Information (once per app)
//   bun Tools/testflight.ts distribute <build>    distribute an uploaded build, print JSON { publicLink, … }
//   bun Tools/testflight.ts uploaded <build>      exit 0 when App Store Connect already has the build
//   bun Tools/testflight.ts link                  print the public link (empty until the group exists)
//
// Env: ASC_KEY_ID and ASC_ISSUER_ID (a team API key with the App Manager role or higher; export
// them in the publishing Mac's shell profile, not in this repo); the .p8 lives at ASC_KEY_PATH, default ~/.appstoreconnect/private_keys/AuthKey_<key id>.p8, where xcodebuild
// and altool also look. setup also reads ASC_FEEDBACK_EMAIL and ASC_CONTACT_FIRST,
// ASC_CONTACT_LAST, ASC_CONTACT_EMAIL, ASC_CONTACT_PHONE for the Beta App Review contact.
//
// App Store Connect has no API for creating the app itself: add it once in the web UI (Apps → + →
// New App, bundle ID com.markhuot.harness) before the first upload.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const BUNDLE_ID = "com.markhuot.harness";
export const GROUP_NAME = "Public";
const API = "https://api.appstoreconnect.apple.com/v1";
const SITE = "https://harness-install.vercel.app";

export const TEST_INFO = {
  description:
    "Harness runs coding agents from a kanban board on your Mac. This app is the iPhone and iPad companion: pair it with the Mac app to follow tickets, read agent transcripts, answer blocked agents and approve reviews from your phone.",
  privacyPolicyUrl: `${SITE}/privacy.html`,
  reviewNotes:
    "Harness is a companion to the Harness Mac app, which runs on the tester's own Mac. The iPhone app has no account and no server of ours: it connects only to that Mac, over the local network or Tailscale, after scanning a pairing QR code shown in the Mac app (Settings → Network). Without a paired Mac the app shows its pairing screen. The Mac app is a free download at " +
    `${SITE}.`,
};

const b64url = (b: ArrayBuffer | Uint8Array | string) =>
  Buffer.from(typeof b === "string" ? b : b instanceof Uint8Array ? b : new Uint8Array(b)).toString("base64url");

/** An App Store Connect API token: ES256 JWT, 20 minutes (Apple's maximum). */
export async function token(keyId: string, issuerId: string, pem: string, now = Date.now()): Promise<string> {
  const der = Buffer.from(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""), "base64");
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const iat = Math.floor(now / 1000);
  const head = b64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const body = b64url(JSON.stringify({ iss: issuerId, iat, exp: iat + 20 * 60, aud: "appstoreconnect-v1" }));
  // WebCrypto's ECDSA signature is already the raw r||s form JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

type Resource = { id: string; type: string; attributes: Record<string, any> };
export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export class AscError extends Error {
  constructor(readonly status: number, readonly codes: string[], message: string) {
    super(message);
  }
}

export function client(auth: () => Promise<string>, fetchImpl: Fetch = fetch) {
  async function call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await fetchImpl(path.startsWith("http") ? path : API + path, {
      method,
      headers: { Authorization: `Bearer ${await auth()}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const errors: any[] = json?.errors ?? [];
      const detail = errors.map((e) => `${e.code}: ${e.detail ?? e.title}`).join("; ") || text;
      throw new AscError(res.status, errors.map((e) => String(e.code)), `${method} ${path} → ${res.status} ${detail}`);
    }
    return json;
  }
  return {
    get: (p: string): Promise<{ data: any; included?: Resource[] }> => call("GET", p),
    post: (p: string, b: unknown) => call("POST", p, b),
    patch: (p: string, b: unknown) => call("PATCH", p, b),
  };
}
export type Client = ReturnType<typeof client>;

export async function findApp(c: Client): Promise<Resource> {
  const { data } = await c.get(`/apps?filter[bundleId]=${BUNDLE_ID}&limit=1`);
  if (!data?.[0]) {
    throw new Error(`App Store Connect has no app for ${BUNDLE_ID}; create it once in the web UI (Apps → + → New App) and rerun`);
  }
  return data[0];
}

/** The external group with the public link, created (link on, feedback on) when it's missing. */
export async function ensureGroup(c: Client, appId: string): Promise<Resource> {
  const { data } = await c.get(`/betaGroups?filter[app]=${appId}&filter[name]=${GROUP_NAME}&limit=10`);
  const found = (data as Resource[]).find((g) => g.attributes.name === GROUP_NAME && !g.attributes.isInternalGroup);
  if (found) {
    if (found.attributes.publicLinkEnabled) return found;
    return (await c.patch(`/betaGroups/${found.id}`, {
      data: { type: "betaGroups", id: found.id, attributes: { publicLinkEnabled: true } },
    })).data;
  }
  return (await c.post("/betaGroups", {
    data: {
      type: "betaGroups",
      attributes: { name: GROUP_NAME, publicLinkEnabled: true, publicLinkLimitEnabled: false, feedbackEnabled: true },
      relationships: { app: { data: { type: "apps", id: appId } } },
    },
  })).data;
}

/** Wait until App Store Connect has processed the upload (it can take a few minutes to appear). */
export async function waitForBuild(
  c: Client,
  appId: string,
  buildNumber: string,
  { timeoutMs = 45 * 60_000, pollMs = 30_000, sleep = (ms: number) => Bun.sleep(ms), log = console.error } = {},
): Promise<Resource> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { data } = await c.get(`/builds?filter[app]=${appId}&filter[version]=${buildNumber}&limit=1`);
    const build: Resource | undefined = data?.[0];
    const state = build?.attributes.processingState;
    if (state === "VALID") return build!;
    if (state === "FAILED" || state === "INVALID") throw new Error(`build ${buildNumber} failed processing (${state})`);
    if (Date.now() >= deadline) throw new Error(`build ${buildNumber} wasn't processed in time (last state: ${state ?? "not visible yet"})`);
    log(`    build ${buildNumber}: ${state ?? "not visible yet"}, waiting`);
    await sleep(pollMs);
  }
}

/** Add the build to the group and submit it for Beta App Review; resubmitting an already submitted build is fine. */
export async function distribute(c: Client, buildNumber: string, whatsNew: string, opts?: Parameters<typeof waitForBuild>[3]) {
  const app = await findApp(c);
  const build = await waitForBuild(c, app.id, buildNumber, opts);
  const group = await ensureGroup(c, app.id);
  if (whatsNew) {
    const { data: locs } = await c.get(`/builds/${build.id}/betaBuildLocalizations`);
    const en = (locs as Resource[]).find((l) => l.attributes.locale === "en-US");
    const attributes = { whatsNew: whatsNew.slice(0, 4000) };
    if (en) await c.patch(`/betaBuildLocalizations/${en.id}`, { data: { type: "betaBuildLocalizations", id: en.id, attributes } });
    else await c.post("/betaBuildLocalizations", {
      data: { type: "betaBuildLocalizations", attributes: { ...attributes, locale: "en-US" }, relationships: { build: { data: { type: "builds", id: build.id } } } },
    });
  }
  await c.post(`/betaGroups/${group.id}/relationships/builds`, { data: [{ type: "builds", id: build.id }] });
  let review = "submitted";
  try {
    await c.post("/betaAppReviewSubmissions", { data: { type: "betaAppReviewSubmissions", relationships: { build: { data: { type: "builds", id: build.id } } } } });
  } catch (e) {
    // 409 means it's already in review or approved (a later build of an approved version is often waved through).
    if (e instanceof AscError && e.status === 409) review = `not resubmitted (${e.message.split("→ ")[1]})`;
    // Only one build per version can wait in Beta App Review. This one is in the group with its notes;
    // submit it once the earlier build clears, by rerunning `distribute` for it.
    else if (e instanceof AscError && e.codes.includes("ENTITY_UNPROCESSABLE.ANOTHER_BUILD_IN_REVIEW"))
      review = `waiting: another build is in beta review; once it clears, run \`bun Tools/testflight.ts distribute ${buildNumber}\``;
    else throw e;
  }
  return { publicLink: group.attributes.publicLink as string | null, build: build.attributes.version as string, group: group.id, review };
}

/** One-time Test Information: description, feedback email, privacy policy, review contact and notes. */
export async function setup(c: Client, env: Record<string, string | undefined>) {
  const app = await findApp(c);
  const missing: string[] = [];
  const { data: locs } = await c.get(`/apps/${app.id}/betaAppLocalizations`);
  const en = (locs as Resource[]).find((l) => l.attributes.locale === "en-US");
  const locAttrs: Record<string, string> = { description: TEST_INFO.description, privacyPolicyUrl: TEST_INFO.privacyPolicyUrl };
  if (env.ASC_FEEDBACK_EMAIL) locAttrs.feedbackEmail = env.ASC_FEEDBACK_EMAIL;
  else if (!en?.attributes.feedbackEmail) missing.push("ASC_FEEDBACK_EMAIL");
  if (en) await c.patch(`/betaAppLocalizations/${en.id}`, { data: { type: "betaAppLocalizations", id: en.id, attributes: locAttrs } });
  else await c.post("/betaAppLocalizations", {
    data: { type: "betaAppLocalizations", attributes: { ...locAttrs, locale: "en-US" }, relationships: { app: { data: { type: "apps", id: app.id } } } },
  });

  const { data: detail } = await c.get(`/apps/${app.id}/betaAppReviewDetail`);
  const contact: Record<string, string> = {};
  for (const [envKey, attr] of [["ASC_CONTACT_FIRST", "contactFirstName"], ["ASC_CONTACT_LAST", "contactLastName"], ["ASC_CONTACT_EMAIL", "contactEmail"], ["ASC_CONTACT_PHONE", "contactPhone"]] as const) {
    if (env[envKey]) contact[attr] = env[envKey]!;
    else if (!detail.attributes[attr]) missing.push(envKey);
  }
  await c.patch(`/betaAppReviewDetails/${detail.id}`, {
    data: { type: "betaAppReviewDetails", id: detail.id, attributes: { ...contact, notes: TEST_INFO.reviewNotes, demoAccountRequired: false } },
  });
  const group = await ensureGroup(c, app.id);
  return { app: app.id, publicLink: group.attributes.publicLink as string | null, missing };
}

function envClient() {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  // Kept out of this public repo: export both in the shell profile of the Mac that publishes.
  if (!keyId || !issuerId) throw new Error("set ASC_KEY_ID and ASC_ISSUER_ID (App Store Connect → Users and Access → Integrations → Team Keys)");
  const keyPath = process.env.ASC_KEY_PATH ?? join(homedir(), ".appstoreconnect", "private_keys", `AuthKey_${keyId}.p8`);
  let pem: string;
  try {
    pem = readFileSync(keyPath, "utf8");
  } catch {
    throw new Error(`no App Store Connect API key at ${keyPath}; download AuthKey_${keyId}.p8 there (App Store Connect → Users and Access → Integrations) or set ASC_KEY_ID/ASC_KEY_PATH`);
  }
  let cached: { jwt: string; at: number } | undefined;
  return client(async () => {
    if (!cached || Date.now() - cached.at > 15 * 60_000) cached = { jwt: await token(keyId, issuerId, pem), at: Date.now() };
    return cached.jwt;
  });
}

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const c = envClient();
  if (cmd === "distribute" && arg) {
    const whatsNew = process.env.TESTFLIGHT_WHATS_NEW ?? "";
    console.log(JSON.stringify(await distribute(c, arg, whatsNew)));
  } else if (cmd === "setup") {
    const r = await setup(c, process.env);
    console.log(JSON.stringify(r));
    if (r.missing.length) console.error(`still missing for Beta App Review: ${r.missing.join(", ")} (set them and rerun setup)`);
  } else if (cmd === "uploaded" && arg) {
    // Exit 0 when App Store Connect already has this build number, so a rerun doesn't upload it twice.
    const app = await findApp(c);
    const { data } = await c.get(`/builds?filter[app]=${app.id}&filter[version]=${arg}&limit=1`);
    process.exit(data?.[0] ? 0 : 1);
  } else if (cmd === "link") {
    const app = await findApp(c);
    const { data } = await c.get(`/betaGroups?filter[app]=${app.id}&filter[name]=${GROUP_NAME}&limit=10`);
    console.log((data as Resource[]).find((g) => !g.attributes.isInternalGroup)?.attributes.publicLink ?? "");
  } else {
    console.error("usage: bun Tools/testflight.ts setup | distribute <build number> | uploaded <build number> | link");
    process.exit(2);
  }
}
