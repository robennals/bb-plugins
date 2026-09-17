import { describe, expect, it } from "vitest";
import { messageOf } from "./errors.js";

describe("messageOf", () => {
  it("uses an Error's message", () => {
    expect(messageOf(new Error("boom"))).toBe("boom");
  });

  it("stringifies anything else a throw might carry", () => {
    expect(messageOf("plain string")).toBe("plain string");
    expect(messageOf(404)).toBe("404");
  });
});
