// Query strings as HarnessClient (shared/src/client.ts) builds them: URLSearchParams over the
// defined, non-empty values. `query` there isn't exported, so this runs the same steps.
import { cases } from "../case";

type Param = [key: string, value: string | number | null];

function query(params: Param[]): string {
  const q = new URLSearchParams();
  for (const [k, v] of params) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

export const queryCases = cases(query, {
  "no params": [],
  "all empty or null": [
    ["q", ""],
    ["cursor", null],
  ],
  "keeps order and drops empties": [
    ["status", "done"],
    ["projectId", null],
    ["q", "fix bug"],
    ["limit", 50],
    ["cursor", ""],
  ],
  "form encoding (space is +, reserved characters escaped)": [["q", "a b&c=d/é!~*()'+"]],
  "comma-joined status list": [["status", "planning,review"]],
  "zero is kept": [["limit", 0]],
  "fractional number": [["after", 1.5]],
  "path with slashes and dots": [["path", "src/app/../x y.ts"]],
  "emoji": [["q", "🚀 launch"]],
});
