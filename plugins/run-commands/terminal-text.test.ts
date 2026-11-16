import { describe, expect, it } from "vitest";
import { displayText, outputMentions, splitLinks, stripAnsi, stripAnsiStreaming } from "./terminal-text.js";

describe("stripAnsi", () => {
  it("drops colours, cursor moves and window titles", () => {
    expect(stripAnsi("\u001b[1;32mready\u001b[0m \u001b[2K\u001b]0;title\u0007done")).toBe("ready done");
  });
});

describe("stripAnsiStreaming", () => {
  it("holds back an escape sequence cut off by the end of a read", () => {
    expect(stripAnsiStreaming("ready \u001b[3")).toEqual({ plain: "ready ", rest: "\u001b[3" });
  });

  it("finishes it with the next read", () => {
    expect(stripAnsiStreaming("\u001b[3" + "2mgo\u001b[0m")).toEqual({ plain: "go", rest: "" });
  });

  it("gives up on a 'sequence' that never ends rather than holding output back for ever", () => {
    const junk = "\u001b[" + "1".repeat(300);
    expect(stripAnsiStreaming(junk).rest).toBe("");
  });
});

describe("outputMentions", () => {
  it("finds the address a dev server prints", () => {
    expect(outputMentions("  ➜  Local:   http://localhost:5173/\r\n", "http://localhost:5173")).toBe(true);
  });

  it("finds it once Vite's colour codes around the port are stripped", () => {
    const vite = "Local: \u001b[36mhttp://localhost:\u001b[1m5173\u001b[22m/\u001b[39m";
    expect(outputMentions(stripAnsi(vite), "http://localhost:5173/app")).toBe(true);
  });

  it("is not fooled by a different port", () => {
    expect(outputMentions("listening on localhost:3001", "http://localhost:3000")).toBe(false);
  });
});

describe("displayText", () => {
  it("keeps only the last state of a line redrawn with carriage returns", () => {
    expect(displayText("installing 10%\rinstalling 50%\rinstalling 100%\r\ndone\n")).toBe(
      "installing 100%\ndone\n",
    );
  });

  it("keeps a line that ends in a carriage return until something overwrites it", () => {
    expect(displayText("building 40%\r")).toBe("building 40%");
  });

  it("drops stray control characters but keeps tabs", () => {
    expect(displayText("a\tb\u0007c\u0008")).toBe("a\tbc");
  });
});

describe("splitLinks", () => {
  it("picks out the address a dev server prints", () => {
    expect(splitLinks("  ➜  Local:   http://localhost:5173/\n")).toEqual([
      { text: "  ➜  Local:   " },
      { text: "http://localhost:5173/", url: "http://localhost:5173/" },
      { text: "\n" },
    ]);
  });

  it("leaves sentence punctuation and a closing bracket outside the link", () => {
    expect(splitLinks("see (https://example.com/a), then https://example.com/b.")).toEqual([
      { text: "see (" },
      { text: "https://example.com/a", url: "https://example.com/a" },
      { text: "), then " },
      { text: "https://example.com/b", url: "https://example.com/b" },
      { text: "." },
    ]);
  });

  it("keeps a bracket that belongs to the address", () => {
    const url = "https://en.wikipedia.org/wiki/Foo_(bar)";
    expect(splitLinks(url)).toEqual([{ text: url, url }]);
  });

  it("stops at quotes", () => {
    expect(splitLinks(`url="http://localhost:3000/x"`)).toEqual([
      { text: `url="` },
      { text: "http://localhost:3000/x", url: "http://localhost:3000/x" },
      { text: `"` },
    ]);
  });

  it("does not link a scheme with nothing after it, or other schemes", () => {
    expect(splitLinks("http:// and ftp://example.com")).toEqual([{ text: "http:// and ftp://example.com" }]);
  });

  it("returns no pieces for no text", () => {
    expect(splitLinks("")).toEqual([]);
  });
});
