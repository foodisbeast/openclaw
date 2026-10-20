import { STREAM_ERROR_FALLBACK_TEXT } from "@openclaw/ai/internal/shared";
import { describe, expect, it } from "vitest";
import {
  buildAgentMessageFromConversationEntries as buildPrompt,
  type ConversationEntry,
} from "./agent-prompt.js";

function message(
  role: ConversationEntry["role"],
  body: string,
  sender: string = role === "user" ? "User" : "Assistant",
) {
  return { role, entry: { sender, body } };
}

describe("gateway agent prompt", () => {
  it("returns empty for no entries", () => {
    expect(buildPrompt([])).toBe("");
  });

  it("extracts text from content-array body when there is no history", () => {
    expect(
      buildPrompt([
        message("user", [
          { type: "text", text: "hi" },
          { type: "image", data: "base64-image", mimeType: "image/png" },
          { type: "text", text: "there" },
        ] as unknown as string),
      ]),
    ).toBe("hi there");
  });

  it("prefers last tool entry over assistant for current message", () => {
    const entries = [
      message("user", "question"),
      message("tool", "tool output", "Tool:x"),
      message("assistant", "assistant text"),
    ] as const;

    expect(buildPrompt([...entries])).toBe(
      "[Chat messages since your last reply - for context]\nUser: question\n\n[Current message - respond to this]\nTool:x: tool output",
    );
  });

  it("normalizes content-array bodies in history and current message", () => {
    const entries = [
      message("assistant", [{ type: "text", text: "prev" }] as unknown as string),
      message("user", [
        { type: "text", text: "next" },
        { type: "text", text: "step" },
      ] as unknown as string),
    ] as const;

    expect(buildPrompt([...entries])).toBe(
      "[Chat messages since your last reply - for context]\nAssistant: prev\n\n[Current message - respond to this]\nUser: next step",
    );
  });
  it("omits internal stream-error placeholder text from replay history", () => {
    const entries = [
      message("user", "first"),
      {
        ...message("assistant", [
          { type: "text", text: STREAM_ERROR_FALLBACK_TEXT },
        ] as unknown as string),
        internalStreamError: true,
      },
      message("user", "retry"),
    ] as const;

    const prompt = buildPrompt([...entries]);
    expect(prompt).not.toContain(STREAM_ERROR_FALLBACK_TEXT);
    expect(prompt).not.toContain("Assistant:");
    expect(prompt).toContain("User: first");
    expect(prompt).toContain("User: retry");
  });

  it("preserves exact stream-error placeholder text from assistant history without provenance", () => {
    const entries = [
      message("assistant", STREAM_ERROR_FALLBACK_TEXT),
      message("user", "next"),
    ] as const;

    const prompt = buildPrompt([...entries]);
    expect(prompt).toContain(`Assistant: ${STREAM_ERROR_FALLBACK_TEXT}`);
  });

  it("preserves empty tool outputs in replay history", () => {
    const entries = [
      message("user", "lookup"),
      message("tool", "", "Tool:call_1"),
      message("user", "continue"),
    ] as const;

    const prompt = buildPrompt([...entries]);
    expect(prompt).toContain("Tool:call_1: ");
    expect(prompt).toContain("User: continue");
  });
});
