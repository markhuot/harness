import { describe, expect, test } from "bun:test";
import { attachmentsLabel, stepAttachment, thumbnailBox } from "./attachments";

describe("thumbnailBox", () => {
  test("keeps the image's aspect ratio when its dimensions are known", () => {
    expect(thumbnailBox({ width: 1600, height: 900 }, 90)).toEqual({ width: 160, height: 90 });
  });

  test("clamps a very wide or very tall image", () => {
    expect(thumbnailBox({ width: 4000, height: 400 }, 100)).toEqual({ width: 250, height: 100 });
    expect(thumbnailBox({ width: 390, height: 2400 }, 100)).toEqual({ width: 50, height: 100 });
  });

  test("falls back to 4:3 when a dimension is missing or zero", () => {
    expect(thumbnailBox({}, 90)).toEqual({ width: 120, height: 90 });
    expect(thumbnailBox({ width: 800 }, 90)).toEqual({ width: 120, height: 90 });
    expect(thumbnailBox({ width: 800, height: 0 }, 90)).toEqual({ width: 120, height: 90 });
  });
});

describe("stepAttachment", () => {
  test("moves within the list", () => {
    expect(stepAttachment(1, 1, 4)).toBe(2);
    expect(stepAttachment(2, -1, 4)).toBe(1);
  });

  test("wraps past either end", () => {
    expect(stepAttachment(3, 1, 4)).toBe(0);
    expect(stepAttachment(0, -1, 4)).toBe(3);
  });

  test("stays put with a single attachment, and returns 0 for none", () => {
    expect(stepAttachment(0, 1, 1)).toBe(0);
    expect(stepAttachment(0, -1, 1)).toBe(0);
    expect(stepAttachment(0, 1, 0)).toBe(0);
  });
});

describe("attachmentsLabel", () => {
  test("counts images and videos, singular and plural", () => {
    expect(attachmentsLabel([{ kind: "image" }])).toBe("1 image");
    expect(attachmentsLabel([{ kind: "video" }, { kind: "video" }])).toBe("2 videos");
    expect(attachmentsLabel([{ kind: "video" }, { kind: "image" }, { kind: "image" }])).toBe("2 images, 1 video");
  });

  test("is empty without attachments", () => {
    expect(attachmentsLabel([])).toBe("");
  });
});
