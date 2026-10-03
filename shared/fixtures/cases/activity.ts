// Show details in the Activity tab (shared/src/state/activity.ts) for HarnessKit's ActivityRows.fullText.
import { activityDetail } from "../../src/state/activity";
import { cases } from "../case";

export const activityDetailCases = cases(activityDetail, {
  "no detail": { body: "Fixed it.", meta: {} },
  "blank detail": { body: "Fixed it.", meta: { detail: "  \n " } },
  "detail is the body": { body: "Fixed it.", meta: { detail: " Fixed it.\n" } },
  "the rest after the first line": { body: "Two problems.", meta: { detail: "Two problems.\n\n- `a.ts:3`: rethrow\n- assert the error path" } },
  "first line was a heading": { body: "Summary", meta: { detail: "## Summary\n- did it" } },
  "first line was a list item": { body: "Retry cap?", meta: { detail: "- Retry cap?\n- Safari?" } },
  "blank lines before the first line": { body: "Done", meta: { detail: "\n\nDone\n\nAdded the button." } },
  "detail that doesn't start with the body": { body: "Permission needed: Bash — npm publish", meta: { detail: "Classifier: [Code from External]" } },
});
