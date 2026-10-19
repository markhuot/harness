import { describe, expect, test } from "bun:test";
import type { ToolResultContent } from "../../../shared/src/protocol";
import { toolOutputMedia } from "../../../shared/src/state/attachments";

const image = (data: string, mimeType = "image/png"): ToolResultContent => ({ type: "image", data, mimeType });
const words = (text: string): ToolResultContent => ({ type: "text", text });

describe("toolOutputMedia", () => {
  test("keeps the images in order, each pointing back at its block past the text between them", () => {
    const media = toolOutputMedia("call-1", "screenshot", [words("before"), image("AAAA"), words("between"), image("BBBB", "image/jpeg")]);
    expect(media.map((m) => m.at)).toEqual([1, 3]);
    expect(media.map((m) => m.url)).toEqual(["data:image/png;base64,AAAA", "data:image/jpeg;base64,BBBB"]);
  });

  test("numbers the names only when there's more than one, with ids unique to the call", () => {
    expect(toolOutputMedia("call-1", "screenshot", [image("AAAA")]).map((m) => m.attachment.name)).toEqual(["screenshot output"]);
    const two = toolOutputMedia("call-1", "screenshot", [image("AAAA"), image("BBBB")]);
    expect(two.map((m) => m.attachment.name)).toEqual(["screenshot output 1", "screenshot output 2"]);
    const other = toolOutputMedia("call-2", "screenshot", [image("AAAA")]);
    expect(new Set([...two, ...other].map((m) => m.attachment.id)).size).toBe(3);
  });

  test("a video block opens as a video; a result with no images has nothing to open", () => {
    expect(toolOutputMedia("c", "record", [image("AAAA", "video/mp4")])[0]!.attachment.kind).toBe("video");
    expect(toolOutputMedia("c", "Read", [words("class HarnessSocket {}")])).toEqual([]);
  });
});
