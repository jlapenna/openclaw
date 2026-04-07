import { describe, expect, it } from "vitest";
import { appendUniqueSuffix } from "./join-segments.js";

describe("appendUniqueSuffix (Boundary-Aware)", () => {
  it("appends non-overlapping segments", () => {
    expect(appendUniqueSuffix("hello", " world")).toBe("hello world");
  });

  it("merges full word overlaps", () => {
    // Overlap "you" (length 3). Base has space before "you" -> Boundary!
    expect(appendUniqueSuffix("I hear you", "you - hello")).toBe("I hear you - hello");
  });

  it("merges with space boundary in base", () => {
    // Overlap "am ". Base has space before "am " -> Boundary!
    expect(appendUniqueSuffix("I am ", "am reading")).toBe("I am reading");
  });

  it("merges with space boundary in suffix", () => {
    // Overlap "read". Suffix has space after "read" -> Boundary!
    expect(appendUniqueSuffix("I am read", "read a book")).toBe("I am read a book");
  });

  it("resolves the book problem (no merge because no boundaries)", () => {
    // Overlap "o". Neither "b" nor "k" are boundaries.
    expect(appendUniqueSuffix("bo", "ok")).toBe("book");
  });

  it("preserves double letters within words", () => {
    // Overlap "k". Neither "o" nor "e" are boundaries.
    expect(appendUniqueSuffix("book", "keeper")).toBe("bookkeeper");
  });

  it("merges single space overlaps (isolated by string boundaries)", () => {
    // Overlap " ". Base ends in space, suffix starts with space. Boundary on both sides!
    expect(appendUniqueSuffix("hello ", " world")).toBe("hello world");
  });

  it("merges long overlaps regardless of boundaries", () => {
    const base = "I am a helpful assistant. I can help you with many things.";
    const suffix = "I am a helpful assistant. I can help you with many things. How can I help?";
    // Overlap is 58 chars. Merge!
    expect(appendUniqueSuffix(base, suffix)).toBe(
      "I am a helpful assistant. I can help you with many things. How can I help?",
    );
  });

  it("merges punctuation-based overlaps", () => {
    // Overlap "...". "." is a boundary.
    expect(appendUniqueSuffix("Wait...", "... more")).toBe("Wait... more");
  });

  it("prefers longer valid overlaps", () => {
    // "banana" + "ananas".
    // overlap "anana": base[0] is "b" (no), suffix[5] is "s" (no). No.
    // Result: bananaananas
    expect(appendUniqueSuffix("banana", "ananas")).toBe("bananaananas");
  });
});
