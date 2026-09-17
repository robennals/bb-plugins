import { describe, expect, it } from "vitest";
import { messageOf } from "./errors.js";

describe("messageOf", () => {
  it("uses an Error's own message", () => {
    expect(messageOf(new Error("gh is not authenticated"))).toBe("gh is not authenticated");
  });

  it("still says something for a thrown value that is not an Error", () => {
    expect(messageOf("revision mismatch")).toBe("revision mismatch");
  });
});
