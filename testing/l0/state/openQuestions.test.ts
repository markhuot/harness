import { describe, expect, test } from "bun:test";
import { parseBlocks } from "../../../shared/src/state/markdown";
import { composeQuestionReplies, openQuestionCount, openQuestions, questionPanel, sendableQuestionReplies } from "../../../shared/src/state/openQuestions";
import { EMPTY_MESSAGE_DRAFT, hasMessageDraft, questionReply, withQuestionReply } from "../../../shared/src/state/messageDrafts";

describe("parseBlocks: task lists", () => {
  test("[ ] and [x]/[X] open a task item, whose marker leaves the text", () => {
    expect(parseBlocks("- [ ] a\n- [x] b\n* [X] c")).toEqual([
      {
        t: "ul",
        items: [
          { text: "a", children: [], checked: false },
          { text: "b", children: [], checked: true },
          { text: "c", children: [], checked: true },
        ],
      },
    ]);
  });
  test("plain items carry no checked; brackets without a space after, or with nothing after, are text", () => {
    expect(parseBlocks("- a\n- [ ]\n- [x]b\n- [link](https://x.y)")).toEqual([
      { t: "ul", items: [{ text: "a", children: [] }, { text: "[ ]", children: [] }, { text: "[x]b", children: [] }, { text: "[link](https://x.y)", children: [] }] },
    ]);
  });
  test("numbered and nested items can be tasks too", () => {
    const [ol] = parseBlocks("1. [x] a\n   - [ ] b");
    expect(ol).toEqual({ t: "ol", start: 1, items: [{ text: "a", checked: true, children: [{ t: "ul", items: [{ text: "b", children: [], checked: false }] }] }] });
  });
});

describe("openQuestions", () => {
  const spec = (section: string) => `# T\n\n## Goal\n\n- [ ] not a question\n\n## Open questions\n\n${section}\n\n## Later\n\n- [ ] also not one\n`;

  test("the task items under the heading, in order, checked or not", () => {
    expect(openQuestions(spec("- [ ] Which DB?\n- [x] Which port?\n- [ ] Ship when?"))).toEqual([
      { text: "Which DB?", checked: false },
      { text: "Which port?", checked: true },
      { text: "Ship when?", checked: false },
    ]);
  });
  test("plain bullets and prose under the heading aren't questions", () => {
    expect(openQuestions(spec("None.\n\n- a plain bullet"))).toEqual([]);
  });
  test("the heading matches at any level and case, with or without a colon or plural", () => {
    expect(openQuestions("### OPEN QUESTIONS:\n- [ ] a")).toEqual([{ text: "a", checked: false }]);
    expect(openQuestions("# Open question\n- [ ] a")).toEqual([{ text: "a", checked: false }]);
    expect(openQuestions("## Questions\n- [ ] a")).toEqual([]);
  });
  test("a deeper heading stays inside the section; a same-level one ends it", () => {
    expect(openQuestions("## Open questions\n### Design\n- [ ] a\n## Status\n- [ ] b").map((q) => q.text)).toEqual(["a"]);
  });
  test("nested task items count; their plain parents don't", () => {
    expect(openQuestions("## Open questions\n- Grouping\n  - [ ] a\n  - [x] b").map((q) => q.text)).toEqual(["a", "b"]);
  });
  test("no heading, no questions; the count is the unchecked ones", () => {
    expect(openQuestions("# T\n- [ ] a")).toEqual([]);
    expect(openQuestionCount(spec("- [ ] a\n- [x] b\n- [ ] c"))).toBe(2);
  });
});

describe("composeQuestionReplies", () => {
  test("each question quoted with its reply under it, in order, then the typed text", () => {
    expect(composeQuestionReplies([{ question: "Which DB?", body: "Postgres." }, { question: "Ship when?", body: " Friday \n" }], "Also, thanks.")).toBe(
      "> Which DB?\n\nPostgres.\n\n> Ship when?\n\nFriday\n\nAlso, thanks.",
    );
  });
  test("blank replies are dropped; with none left it's the text alone", () => {
    expect(composeQuestionReplies([{ question: "a", body: "  " }], "hi")).toBe("hi");
    expect(composeQuestionReplies([{ question: "a", body: "yes" }], "  ")).toBe("> a\n\nyes");
  });
});

describe("message draft question replies", () => {
  test("setting keeps one entry per question in place; clearing drops it", () => {
    let v = withQuestionReply(EMPTY_MESSAGE_DRAFT, "a", "1");
    v = withQuestionReply(v, "b", "2");
    v = withQuestionReply(v, "a", "1!");
    expect(v.questionReplies).toEqual([{ question: "a", body: "1!" }, { question: "b", body: "2" }]);
    expect(questionReply(v, "b")).toBe("2");
    expect(withQuestionReply(v, "a", "").questionReplies).toEqual([{ question: "b", body: "2" }]);
  });
  test("replies alone don't flag a draft on the card: they stay after they're sent", () => {
    const base = { text: "", attachments: [], origin: null, updatedAt: 1 };
    expect(hasMessageDraft({ ...base, questionReplies: [{ question: "a", body: "x" }] })).toBe(false);
    expect(hasMessageDraft({ ...base, text: "hi", questionReplies: [{ question: "a", body: "x" }] })).toBe(true);
  });
});

describe("specDiff: task items", () => {
  test("checking an item off is an edit carrying both checkboxes", async () => {
    const { specDiff } = await import("../../../shared/src/state/specDiff");
    const [list] = specDiff("- [ ] Which DB?\n- [ ] Port?", "- [x] Which DB?\n- [ ] Port?");
    expect(list!.change).toBe("edit");
    const items = (list as { block: { items: { change: string; checked?: boolean; wasChecked?: boolean }[] } }).block.items;
    expect(items[0]).toMatchObject({ change: "edit", checked: true, wasChecked: false });
    expect(items[1]!.change).toBe("same");
  });
});

describe("questionPanel and sendableQuestionReplies", () => {
  const spec = "## Open questions\n- [ ] Which DB?\n- [x] Which port?\n- [ ] Ship when?";

  test("open and answered questions in spec order, each with its drafted reply", () => {
    const p = questionPanel(spec, [{ question: "Ship when?", body: "Friday" }]);
    expect(p.open).toEqual([
      { question: "Which DB?", checked: false, draft: "" },
      { question: "Ship when?", checked: false, draft: "Friday" },
    ]);
    expect(p.answered.map((q) => q.question)).toEqual(["Which port?"]);
  });
  test("a send carries only non-blank replies under questions still open", () => {
    const replies = [
      { question: "Which DB?", body: " PG " },
      { question: "Which port?", body: "5432" },
      { question: "Reworded?", body: "yes" },
      { question: "Ship when?", body: "  " },
    ];
    expect(sendableQuestionReplies(spec, replies)).toEqual([{ question: "Which DB?", body: "PG" }]);
  });
});

describe("specDiff: task items", () => {
  test("checking an item off is an edit carrying both checkboxes", async () => {
    const { specDiff } = await import("../../../shared/src/state/specDiff");
    const [list] = specDiff("- [ ] Which DB?\n- [ ] Port?", "- [x] Which DB?\n- [ ] Port?");
    expect(list!.change).toBe("edit");
    const items = (list as { block: { items: { change: string; checked?: boolean; wasChecked?: boolean }[] } }).block.items;
    expect(items[0]).toMatchObject({ change: "edit", checked: true, wasChecked: false });
    expect(items[1]!.change).toBe("same");
  });
});
