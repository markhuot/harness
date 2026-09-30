// Links to project files in chat messages. Agents write `harness://file/<path>[#L<start>[-L<end>]]`,
// where the path is relative to the root of the ticket the message belongs to (its workdir, else its
// project's path); `?ticket=KEY` or `?project=<id>` points it at another context. Plain markdown
// links without a scheme (`[a](src/a.ts#L10)`, `[b](./b.ts)`, `/Users/…/c.ts`) count too, since agents
// write those as often. The markdown parser makes all of these link tokens and the renderers call
// parseFileLink to open them in the file pane.

export interface FileLink {
  /** Normalized path: no `./`, no `..`, no leading slash unless absolute. */
  path: string;
  startLine?: number;
  endLine?: number;
  ticketKey?: string;
  projectId?: string;
  /** The link named an absolute path; the UI resolves it only when it's inside the root. */
  absolute: boolean;
}

const PREFIX = "harness://file/";
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const LINES = /^L(\d+)(?:-L?(\d+))?$/;

/** The file a link points at, or null when it isn't a file link (another scheme, an anchor, garbage). */
export function parseFileLink(url: string): FileLink | null {
  let rest: string;
  if (url.slice(0, PREFIX.length).toLowerCase() === PREFIX) rest = url.slice(PREFIX.length);
  else if (SCHEME.test(url) || url.startsWith("//") || url.startsWith("#")) return null;
  else rest = url;

  const hashAt = rest.indexOf("#");
  const hash = hashAt >= 0 ? rest.slice(hashAt + 1) : "";
  if (hashAt >= 0) rest = rest.slice(0, hashAt);
  const queryAt = rest.indexOf("?");
  const query = queryAt >= 0 ? rest.slice(queryAt + 1) : "";
  if (queryAt >= 0) rest = rest.slice(0, queryAt);

  let decoded: string;
  try {
    decoded = decodeURIComponent(rest);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const absolute = decoded.startsWith("/");
  const parts: string[] = [];
  for (const seg of decoded.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(seg);
  }
  if (!parts.length) return null;

  const link: FileLink = { path: (absolute ? "/" : "") + parts.join("/"), absolute };
  const lines = LINES.exec(hash);
  if (lines) {
    let start = Number(lines[1]);
    let end = lines[2] === undefined ? undefined : Number(lines[2]);
    if (end !== undefined && end < start) [start, end] = [end, start];
    if (start >= 1) {
      link.startLine = start;
      if (end !== undefined && end !== start) link.endLine = end;
    }
  }
  // Parsed by hand: React Native's URLSearchParams is incomplete.
  for (const pair of query ? query.split("&") : []) {
    const eq = pair.indexOf("=");
    const key = eq >= 0 ? pair.slice(0, eq) : pair;
    let value: string;
    try {
      value = decodeURIComponent((eq >= 0 ? pair.slice(eq + 1) : "").replace(/\+/g, " "));
    } catch {
      continue;
    }
    if (!value) continue;
    if (key === "ticket") link.ticketKey = value;
    else if (key === "project") link.projectId = value;
  }
  return link;
}

/** The canonical `harness://file/…` URL for a file (and optional line range and context). */
export function formatFileLink(link: Omit<FileLink, "absolute"> & { absolute?: boolean }): string {
  const lead = link.path.startsWith("/") ? "/" : "";
  const path = link.path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  const params: string[] = [];
  if (link.ticketKey) params.push(`ticket=${encodeURIComponent(link.ticketKey)}`);
  if (link.projectId) params.push(`project=${encodeURIComponent(link.projectId)}`);
  const query = params.length ? `?${params.join("&")}` : "";
  let hash = "";
  if (link.startLine) {
    const [start, end] = link.endLine && link.endLine < link.startLine ? [link.endLine, link.startLine] : [link.startLine, link.endLine];
    hash = end && end !== start ? `#L${start}-L${end}` : `#L${start}`;
  }
  return `${PREFIX}${lead}${path}${query}${hash}`;
}

/** A short label for a file link: `app.ts`, `app.ts:102`, `app.ts:102-115`. */
export function lineRangeLabel(link: Pick<FileLink, "path" | "startLine" | "endLine">): string {
  const name = link.path.split("/").filter(Boolean).pop() ?? link.path;
  if (!link.startLine) return name;
  return link.endLine ? `${name}:${link.startLine}-${link.endLine}` : `${name}:${link.startLine}`;
}
