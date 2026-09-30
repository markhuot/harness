import { describe, expect, test } from "bun:test";
import { activeCommand, insertCommand, rankCommands, type CommandMatch } from "./commands";

/** activeCommand at the `|` in `s`. */
function at(s: string) {
  const caret = s.indexOf("|");
  return activeCommand(s.replace("|", ""), caret);
}

describe("activeCommand", () => {
  test("a slash that starts the text is a command, up to the caret", () => {
    expect(at("/co|")).toEqual({ start: 0, end: 3, query: "co" });
    expect(at("/|")).toEqual({ start: 0, end: 1, query: "" });
  });

  test("a slash anywhere else isn't: the agent only expands one at the start", () => {
    expect(at("see /co|")).toBeNull();
    expect(at(" /co|")).toBeNull();
    expect(at("src/co|")).toBeNull();
  });

  test("once the name is followed by a space, the caret is in the arguments", () => {
    expect(at("/code-walk this|")).toBeNull();
    expect(at("/code-walk |")).toBeNull();
  });

  test("the caret must be after the slash", () => {
    expect(at("|/code")).toBeNull();
  });

  test("with the caret mid-name, the command runs to the end of the word", () => {
    expect(at("/co|de-walk this branch")).toEqual({ start: 0, end: 10, query: "co" });
  });
});

describe("insertCommand", () => {
  test("replaces the typed name and puts the caret after a space", () => {
    const text = "/co";
    expect(insertCommand(text, activeCommand(text, 3)!, "code-walk")).toEqual({ text: "/code-walk ", caret: 11 });
  });

  test("keeps the arguments already typed after it, without doubling the space", () => {
    const text = "/co this branch";
    expect(insertCommand(text, activeCommand(text, 3)!, "code-walk")).toEqual({ text: "/code-walk this branch", caret: 11 });
  });

  test("replaces the whole word when the caret was mid-name", () => {
    const text = "/cowalk";
    expect(insertCommand(text, activeCommand(text, 3)!, "code-walk").text).toBe("/code-walk ");
  });
});

describe("rankCommands", () => {
  const cmds: CommandMatch[] = [
    { name: "code-walk", description: "Walk a user through code (user)" },
    { name: "vercel:deploy", description: "Deploy the current project to Vercel" },
    { name: "review-on-staging", description: "Merge into staging for a code review" },
    { name: "code-review", description: "Review the current diff" },
    { name: "compact", description: "Clear history but keep a summary" },
    { name: "claude.ai Figma:create_rules (MCP)", description: "Figma rules" },
  ];
  const names = (q: string) => rankCommands(cmds, q).map((c) => c.name);

  test("name prefix, then a part of the name, then anywhere in it", () => {
    expect(names("review")).toEqual(["review-on-staging", "code-review"]);
    expect(names("deploy")).toEqual(["vercel:deploy"]);
    expect(names("ode")).toEqual(["code-walk", "code-review"]);
  });

  test("descriptions count only when no name matches", () => {
    expect(names("summary")).toEqual(["compact"]);
    expect(names("current")).toEqual(["vercel:deploy", "code-review"]);
    // review-on-staging's description says "code review", but two names have "code" in them.
    expect(names("code")).toEqual(["code-walk", "code-review"]);
  });

  test("ties keep the driver's order", () => {
    expect(names("co")).toEqual(["code-walk", "code-review", "compact"]);
  });

  test("case-insensitive", () => {
    expect(names("VERCEL")).toEqual(["vercel:deploy"]);
  });

  test("an empty query lists everything typeable, in order", () => {
    expect(names("")).toEqual(["code-walk", "vercel:deploy", "review-on-staging", "code-review", "compact"]);
  });

  test("names with whitespace can't be typed and never show", () => {
    expect(names("figma")).toEqual([]);
  });

  test("no match lists nothing, and the limit caps the list", () => {
    expect(names("zzz")).toEqual([]);
    expect(rankCommands(cmds, "", 2)).toHaveLength(2);
  });
});
