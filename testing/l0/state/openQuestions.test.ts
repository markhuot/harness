import { describe, expect, test } from "bun:test";
import { parseBlocks } from "../../../shared/src/state/markdown";
import { composeQuestionReplies, needsYouBar, needsYouLayout, openQuestionCount, openQuestions, questionPanel, questionsAnsweredBy, sendableQuestionReplies } from "../../../shared/src/state/openQuestions";
import { EMPTY_MESSAGE_DRAFT, hasMessageDraft, questionReply, withQuestionReply } from "../../../shared/src/state/messageDrafts";

describe("parseBlocks: task and question items", () => {
  test("[ ] and [x]/[X] open a task item, ( ) and (x)/(X) a question, and the marker leaves the text", () => {
    expect(parseBlocks("- [ ] a\n- [x] b\n* [X] c\n- ( ) d\n- (x) e\n+ (X) f")).toEqual([
      {
        t: "ul",
        items: [
          { text: "a", children: [], checked: false },
          { text: "b", children: [], checked: true },
          { text: "c", children: [], checked: true },
          { text: "d", children: [], checked: false, question: true },
          { text: "e", children: [], checked: true, question: true },
          { text: "f", children: [], checked: true, question: true },
        ],
      },
    ]);
  });
  test("plain items carry no checked; markers without a space after, or with nothing after, are text", () => {
    expect(parseBlocks("- a\n- [ ]\n- [x]b\n- [link](https://x.y)\n- ( )\n- (x)b\n- (see below) c")).toEqual([
      {
        t: "ul",
        items: [
          { text: "a", children: [] },
          { text: "[ ]", children: [] },
          { text: "[x]b", children: [] },
          { text: "[link](https://x.y)", children: [] },
          { text: "( )", children: [] },
          { text: "(x)b", children: [] },
          { text: "(see below) c", children: [] },
        ],
      },
    ]);
  });
  test("numbered and nested items can be tasks and questions too", () => {
    const [ol] = parseBlocks("1. [x] a\n   - ( ) b");
    expect(ol).toEqual({ t: "ol", start: 1, items: [{ text: "a", checked: true, children: [{ t: "ul", items: [{ text: "b", children: [], checked: false, question: true }] }] }] });
  });
});

describe("openQuestions", () => {
  test("every question item is a question, under any heading or none, in document order", () => {
    const spec = "- ( ) Before any heading\n\n## Goal\n\n- ( ) In the goal\n- a plain bullet\n\n## Open questions\n\n- (x) Which port?\n\n## Status\n\n- ( ) At the end";
    expect(openQuestions(spec)).toEqual([
      { text: "Before any heading", checked: false },
      { text: "In the goal", checked: false },
      { text: "Which port?", checked: true },
      { text: "At the end", checked: false },
    ]);
  });
  test("task items are checklists, not questions, checked or not", () => {
    expect(openQuestions("## Plan\n- [ ] Write the migration\n- [x] Add the column\n\n## Open questions\n- ( ) Which DB?")).toEqual([{ text: "Which DB?", checked: false }]);
    expect(openQuestionCount("- [ ] a\n- [ ] b")).toBe(0);
  });
  test("nested question items count, at any depth; their plain parents and prose don't", () => {
    expect(openQuestions("1. Step\n   - Grouping\n     - ( ) a\n   - (x) b\n\nNone.").map((q) => q.text)).toEqual(["a", "b"]);
  });
  test("question items inside a code block aren't questions", () => {
    expect(openQuestions("```md\n- ( ) example\n```\n- ( ) real")).toEqual([{ text: "real", checked: false }]);
  });
  test("the count is the open ones", () => {
    expect(openQuestionCount("## Plan\n- ( ) a\n## Open questions\n- (x) b\n- ( ) c")).toBe(2);
    expect(openQuestionCount("# T\n- plain")).toBe(0);
  });
});

describe("questionsAnsweredBy", () => {
  const spec = "## Open questions\n- ( ) Which DB?\n- (x) Which port?\n- ( ) Ship when?";
  test("the open questions a composed reply quotes, in spec order", () => {
    const message = composeQuestionReplies([{ question: "Ship when?", body: "Friday" }, { question: "Which DB?", body: "PG" }], "thanks");
    expect(questionsAnsweredBy(spec, message)).toEqual(["Which DB?", "Ship when?"]);
  });
  test("answered questions, unquoted mentions and plain messages answer nothing", () => {
    expect(questionsAnsweredBy(spec, "> Which port?\n\n5432")).toEqual([]);
    expect(questionsAnsweredBy(spec, "What about Which DB? > Ship when?")).toEqual([]);
    expect(questionsAnsweredBy(spec, "Looks good")).toEqual([]);
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

describe("specDiff: task and question items", () => {
  test("checking an item off is an edit carrying both boxes", async () => {
    const { specDiff } = await import("../../../shared/src/state/specDiff");
    const [list] = specDiff("- [ ] Which DB?\n- [ ] Port?", "- [x] Which DB?\n- [ ] Port?");
    expect(list!.change).toBe("edit");
    const items = (list as { block: { items: { change: string; checked?: boolean; wasChecked?: boolean; question?: true }[] } }).block.items;
    expect(items[0]).toEqual(expect.objectContaining({ change: "edit", checked: true, wasChecked: false }));
    expect(items[0]!.question).toBeUndefined();
    expect(items[1]!.change).toBe("same");
  });
  test("answering a question keeps it a question; a task turned question has no earlier box to compare", async () => {
    const { specDiff } = await import("../../../shared/src/state/specDiff");
    const [answered] = specDiff("- ( ) Which DB?", "- (x) Which DB?");
    expect((answered as { block: { items: unknown[] } }).block.items[0]).toMatchObject({ change: "edit", checked: true, wasChecked: false, question: true });
    const [converted] = specDiff("- [x] Which DB?", "- ( ) Which DB?");
    const item = (converted as { block: { items: { wasChecked?: boolean; question?: true }[] } }).block.items[0]!;
    expect(item).toMatchObject({ question: true });
    expect(item.wasChecked).toBeUndefined();
  });
});

describe("questionPanel and sendableQuestionReplies", () => {
  const spec = "## Open questions\n- ( ) Which DB?\n- (x) Which port?\n- ( ) Ship when?";

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

describe("needsYouLayout", () => {
  test("the panel needs a landscape view at least 700 wide and 600 tall", () => {
    expect(needsYouLayout(700, 600)).toBe("panel");
    expect(needsYouLayout(699, 600)).toBe("inline");
    expect(needsYouLayout(700, 599)).toBe("inline");
    expect(needsYouLayout(900, 900)).toBe("inline");
    expect(needsYouLayout(901, 900)).toBe("panel");
  });
  test("iPhones and iPads in portrait go inline; a large iPad in landscape and a full Mac window get the panel", () => {
    expect(needsYouLayout(932, 430)).toBe("inline"); // iPhone Pro Max landscape: too short
    expect(needsYouLayout(1032, 1376)).toBe("inline"); // 13" iPad portrait
    expect(needsYouLayout(1376, 1032)).toBe("panel");
    expect(needsYouLayout(1180, 820)).toBe("panel");
    expect(needsYouLayout(1400, 860)).toBe("panel");
  });
});

describe("needsYouBar", () => {
  test("drafted answers turn it into Send; before that it takes the human to the questions", () => {
    expect(needsYouBar(3, 0, 3)).toEqual({ label: "Needs you · 3", action: "focus" });
    expect(needsYouBar(4, 1, 3)).toEqual({ label: "1/3 answers ready · Send", action: "send" });
    expect(needsYouBar(3, 2, 3)).toEqual({ label: "2/3 answers ready · Send", action: "send" });
    expect(needsYouBar(1, 1, 1)).toEqual({ label: "1/1 answer ready · Send", action: "send" });
    // A reply to a question checked off since still counts, so the total never drops below it.
    expect(needsYouBar(0, 2, 1)).toEqual({ label: "2/2 answers ready · Send", action: "send" });
    expect(needsYouBar(0, 0, 0)).toBeNull();
  });
});
