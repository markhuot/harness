// A ticket's pull request links (DESIGN.md "Pull requests"): the URL check and the title lookup.

import { execFile } from "./plugins/host";

/** The http(s) link a pull request is saved by; the same rule record_pull_request applies. */
export const PULL_REQUEST_URL = /^https?:\/\/\S+$/;

/**
 * A pull request's title, read with `gh pr view <url> --json title` on the service's PATH. Resolves
 * null when gh answered without a title: not logged in to the host, or a URL that isn't a pull
 * request. Rejects when gh couldn't run (missing, spawn failed) or timed out, so the caller can
 * leave the link unchecked and try again on the next start.
 */
export async function fetchPullRequestTitle(url: string): Promise<string | null> {
  const res = await execFile("gh", ["pr", "view", url, "--json", "title"]);
  if (res.code === -1 || res.timedOut) throw new Error(`gh couldn't read ${url}: ${res.timedOut ? "timed out" : res.stderr.trim()}`);
  if (res.code !== 0) return null;
  try {
    const title = (JSON.parse(res.stdout) as { title?: unknown }).title;
    return typeof title === "string" && title.trim() ? title.trim() : null;
  } catch {
    return null;
  }
}
