import { expect, test } from "bun:test";
import { client, distribute, ensureGroup, token, waitForBuild, type Fetch } from "./testflight";

async function p256Pem() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const der = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
  return { pem: `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`, publicKey: pair.publicKey };
}

test("token is an ES256 JWT that verifies with the key's public half, with Apple's claims", async () => {
  const { pem, publicKey } = await p256Pem();
  const jwt = await token("KEY123", "issuer-uuid", pem, Date.UTC(2026, 8, 30, 12));
  const [head, body, sig] = jwt.split(".");
  expect(JSON.parse(Buffer.from(head!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY123", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(body!, "base64url").toString());
  expect(claims).toMatchObject({ iss: "issuer-uuid", aud: "appstoreconnect-v1" });
  expect(claims.exp - claims.iat).toBe(1200); // Apple rejects tokens that live longer than 20 minutes
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, Buffer.from(sig!, "base64url"), new TextEncoder().encode(`${head}.${body}`));
  expect(ok).toBe(true);
});

/** A fake App Store Connect: routes by "METHOD path" (query string included), records every call. */
function fakeAsc(routes: Record<string, (body: any) => [number, unknown]>) {
  const calls: { key: string; body: any }[] = [];
  const f: Fetch = async (url, init) => {
    const key = `${init?.method} ${url.replace("https://api.appstoreconnect.apple.com/v1", "")}`;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ key, body });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ errors: [{ code: "NOT_FOUND", detail: key }] }), { status: 404 });
    const [status, json] = route(body);
    return new Response(json === undefined ? "" : JSON.stringify(json), { status });
  };
  return { c: client(async () => "jwt", f), calls };
}

const groupsPath = "GET /betaGroups?filter[app]=A1&filter[name]=Public&limit=10";
const group = (attrs: object) => ({ id: "G1", type: "betaGroups", attributes: { name: "Public", isInternalGroup: false, ...attrs } });

test("ensureGroup reuses an existing public group without writing", async () => {
  const { c, calls } = fakeAsc({ [groupsPath]: () => [200, { data: [group({ publicLinkEnabled: true, publicLink: "https://testflight.apple.com/join/abc" })] }] });
  expect((await ensureGroup(c, "A1")).attributes.publicLink).toBe("https://testflight.apple.com/join/abc");
  expect(calls.map((x) => x.key)).toEqual([groupsPath]);
});

test("ensureGroup ignores an internal group of the same name and creates the external one", async () => {
  const { c, calls } = fakeAsc({
    [groupsPath]: () => [200, { data: [{ ...group({}), attributes: { name: "Public", isInternalGroup: true } }] }],
    "POST /betaGroups": () => [201, { data: group({ publicLinkEnabled: true, publicLink: "https://testflight.apple.com/join/new" }) }],
  });
  expect((await ensureGroup(c, "A1")).attributes.publicLink).toBe("https://testflight.apple.com/join/new");
  const created = calls.find((x) => x.key === "POST /betaGroups")!.body.data;
  expect(created.attributes).toMatchObject({ name: "Public", publicLinkEnabled: true });
  expect(created.relationships.app.data.id).toBe("A1");
});

test("ensureGroup turns the public link on for an existing group that has it off", async () => {
  const { c, calls } = fakeAsc({
    [groupsPath]: () => [200, { data: [group({ publicLinkEnabled: false })] }],
    "PATCH /betaGroups/G1": () => [200, { data: group({ publicLinkEnabled: true, publicLink: "https://testflight.apple.com/join/on" }) }],
  });
  expect((await ensureGroup(c, "A1")).attributes.publicLink).toBe("https://testflight.apple.com/join/on");
  expect(calls.some((x) => x.key === "POST /betaGroups")).toBe(false);
});

const buildsPath = "GET /builds?filter[app]=A1&filter[version]=202609301424&limit=1";
const quiet = { pollMs: 0, sleep: async () => {}, log: () => {} };

test("waitForBuild polls through 'not visible' and PROCESSING until VALID", async () => {
  const states = [undefined, "PROCESSING", "VALID"];
  const { c, calls } = fakeAsc({
    [buildsPath]: () => {
      const s = states.shift();
      return [200, { data: s ? [{ id: "B1", type: "builds", attributes: { processingState: s, version: "202609301424" } }] : [] }];
    },
  });
  expect((await waitForBuild(c, "A1", "202609301424", quiet)).id).toBe("B1");
  expect(calls.length).toBe(3);
});

test("waitForBuild fails fast on a build App Store Connect rejected", async () => {
  const { c } = fakeAsc({ [buildsPath]: () => [200, { data: [{ id: "B1", type: "builds", attributes: { processingState: "INVALID" } }] }] });
  expect(waitForBuild(c, "A1", "202609301424", quiet)).rejects.toThrow("INVALID");
});

test("waitForBuild gives up at the deadline", async () => {
  const { c } = fakeAsc({ [buildsPath]: () => [200, { data: [] }] });
  expect(waitForBuild(c, "A1", "202609301424", { ...quiet, timeoutMs: 0 })).rejects.toThrow("wasn't processed in time");
});

function distributeRoutes(reviewStatus: number, reviewCode = "ENTITY_ERROR") {
  return {
    "GET /apps?filter[bundleId]=com.markhuot.harness&limit=1": () => [200, { data: [{ id: "A1", type: "apps", attributes: {} }] }],
    [buildsPath]: () => [200, { data: [{ id: "B1", type: "builds", attributes: { processingState: "VALID", version: "202609301424" } }] }],
    [groupsPath]: () => [200, { data: [group({ publicLinkEnabled: true, publicLink: "https://testflight.apple.com/join/abc" })] }],
    "GET /builds/B1/betaBuildLocalizations": () => [200, { data: [] }],
    "POST /betaBuildLocalizations": () => [201, { data: {} }],
    "POST /betaGroups/G1/relationships/builds": () => [204, undefined],
    "POST /betaAppReviewSubmissions": () =>
      reviewStatus < 300 ? [201, { data: {} }] : [reviewStatus, { errors: [{ code: reviewCode, detail: "already submitted" }] }],
  } as Record<string, (b: any) => [number, unknown]>;
}

test("distribute adds the build to the group, submits it for review and returns the public link", async () => {
  const { c, calls } = fakeAsc(distributeRoutes(201));
  const r = await distribute(c, "202609301424", "New stuff", quiet);
  expect(r).toEqual({ publicLink: "https://testflight.apple.com/join/abc", build: "202609301424", group: "G1", review: "submitted" });
  expect(calls.find((x) => x.key === "POST /betaGroups/G1/relationships/builds")!.body.data).toEqual([{ type: "builds", id: "B1" }]);
  expect(calls.find((x) => x.key === "POST /betaBuildLocalizations")!.body.data.attributes).toEqual({ whatsNew: "New stuff", locale: "en-US" });
});

test("distribute tolerates a build that is already in review (409) but not other failures", async () => {
  const again = await distribute(fakeAsc(distributeRoutes(409)).c, "202609301424", "", quiet);
  expect(again.review).toStartWith("not resubmitted");
  expect(distribute(fakeAsc(distributeRoutes(422)).c, "202609301424", "", quiet)).rejects.toThrow("422");
});

test("distribute leaves the build in the group when another build of the version is in beta review", async () => {
  const { c, calls } = fakeAsc(distributeRoutes(422, "ENTITY_UNPROCESSABLE.ANOTHER_BUILD_IN_REVIEW"));
  const r = await distribute(c, "202609301424", "", quiet);
  expect(r.review).toStartWith("waiting");
  expect(r.review).toContain("distribute 202609301424");
  expect(r.publicLink).toBe("https://testflight.apple.com/join/abc");
  expect(calls.some((x) => x.key === "POST /betaGroups/G1/relationships/builds")).toBe(true);
});
