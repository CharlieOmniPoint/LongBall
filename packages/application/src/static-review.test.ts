import { describe, expect, it } from "vitest";
import { assertStaticReviewApiAddress } from "./static-review";
describe("truthful static browser/API boundary", () => {
  it("requires a separate explicit API before a static review can connect", () => {
    for (const value of [
      "",
      "/",
      "/api",
      "api",
      "https://review.example",
      "https://review.example/api",
      "https://review.example/longball/",
    ])
      expect(() =>
        assertStaticReviewApiAddress(value, true, "https://review.example"),
      ).toThrow();
    expect(() =>
      assertStaticReviewApiAddress(
        "https://api.example/longball",
        true,
        "https://review.example",
      ),
    ).not.toThrow();
    expect(() =>
      assertStaticReviewApiAddress(
        "http://127.0.0.1:4320",
        true,
        "http://127.0.0.1:4173",
      ),
    ).not.toThrow();
  });
  it("preserves the combined API/native default and never accepts credential-bearing static URLs", () => {
    expect(() => assertStaticReviewApiAddress("/", false)).not.toThrow();
    for (const value of [
      "https://user:secret@api.example",
      "https://api.example?token=secret",
      "https://api.example#token",
      "file:///tmp/api",
    ])
      expect(() =>
        assertStaticReviewApiAddress(value, true, "https://review.example"),
      ).toThrow();
    expect(() =>
      assertStaticReviewApiAddress("https://api.example", true),
    ).toThrow();
  });
});
