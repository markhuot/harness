import { describe, expect, test } from "bun:test";
import { activityDetail } from "./activity";

describe("activityDetail", () => {
  test("Show details reveals what follows the line the body shows", () => {
    expect(activityDetail({ body: "Two problems.", meta: { detail: "Two problems.\n\n- a\n- b" } })).toBe("- a\n- b");
    expect(activityDetail({ body: "Summary", meta: { detail: "## Summary\n- did it" } })).toBe("- did it");
  });
  test("a detail that doesn't start with the body shows whole", () => {
    expect(activityDetail({ body: "Permission needed: Bash", meta: { detail: "Classifier: denied" } })).toBe("Classifier: denied");
  });
  test("nothing when there's no detail, it's blank, or it only repeats the body", () => {
    expect(activityDetail({ body: "Fixed it.", meta: {} })).toBeUndefined();
    expect(activityDetail({ body: "Fixed it.", meta: { detail: "  \n " } })).toBeUndefined();
    expect(activityDetail({ body: "Fixed it.", meta: { detail: " Fixed it.\n" } })).toBeUndefined();
  });
});
