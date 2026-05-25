import { describe, expect, it } from "vitest";

import { ansiPlainText, ansiToTokens } from "./ansi";

describe("ansiToTokens", () => {
  it("returns plain text as a single default-color token", () => {
    const tokens = ansiToTokens("hello world");
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.text).toBe("hello world");
  });

  it("parses red SGR into the ansi-fg-1 class", () => {
    const input = "\x1b[31merror\x1b[0m next";
    const tokens = ansiToTokens(input);
    const errToken = tokens.find((t) => t.text === "error");
    expect(errToken).toBeTruthy();
    expect(errToken!.classes).toContain("ansi-fg-1");
  });

  it("strips C0 controls other than \\t\\n\\r", () => {
    const input = "a\x07b\x0cc"; // BEL + FF
    const tokens = ansiToTokens(input);
    const joined = tokens.map((t) => t.text).join("");
    expect(joined).toBe("abc");
  });

  it("escapes literal `<` so it cannot leak into the DOM", () => {
    const input = "<script>alert(1)</script>";
    const tokens = ansiToTokens(input);
    const joined = tokens.map((t) => t.text).join("");
    expect(joined).toBe("<script>alert(1)</script>");
  });
});

describe("ansiPlainText", () => {
  it("strips ANSI", () => {
    expect(ansiPlainText("\x1b[31mhi\x1b[0m")).toBe("hi");
  });
});
