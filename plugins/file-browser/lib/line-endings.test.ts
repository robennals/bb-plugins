import { describe, expect, it } from "vitest";
import { lineEndingOf, withLineEnding } from "./line-endings.js";

describe("lineEndingOf", () => {
  it("calls a file with no carriage returns LF", () => {
    expect(lineEndingOf("one\ntwo\n")).toBe("lf");
  });

  it("calls a file with no line breaks at all LF", () => {
    expect(lineEndingOf("one")).toBe("lf");
    expect(lineEndingOf("")).toBe("lf");
  });

  it("calls a file whose every break is CRLF, CRLF", () => {
    expect(lineEndingOf("one\r\ntwo\r\n")).toBe("crlf");
  });

  it("calls a file with both kinds of break mixed", () => {
    expect(lineEndingOf("one\r\ntwo\n")).toBe("mixed");
  });

  it("calls a file with a carriage return on its own mixed", () => {
    expect(lineEndingOf("one\rtwo\r\n")).toBe("mixed");
  });
});

describe("withLineEnding", () => {
  it("leaves LF text alone for an LF file", () => {
    expect(withLineEnding("one\ntwo\n", "lf")).toBe("one\ntwo\n");
  });

  it("puts the carriage returns back for a CRLF file", () => {
    expect(withLineEnding("one\ntwo\n", "crlf")).toBe("one\r\ntwo\r\n");
  });

  it("round-trips a CRLF file through an editor that drops carriage returns", () => {
    const onDisk = "one\r\n\r\ntwo\r\n";
    const inEditor = onDisk.replace(/\r\n/g, "\n");
    expect(lineEndingOf(onDisk)).toBe("crlf");
    expect(withLineEnding(inEditor, "crlf")).toBe(onDisk);
  });
});
