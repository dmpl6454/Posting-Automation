import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock the LangChain OpenAI client ────────────────────────────────────
// describeImageStyle builds a ChatOpenAI client and calls .invoke() with a
// multimodal HumanMessage. We control the invoke() return / throw here.
const mockInvoke = vi.fn();

vi.mock("@langchain/openai", () => ({
  ChatOpenAI: vi.fn().mockImplementation(() => ({
    invoke: mockInvoke,
  })),
}));

// Import after mocking so the module picks up the mocked ChatOpenAI.
import { describeImageStyle } from "../tools/describe-image-style";

const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

describe("describeImageStyle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "sk-test";
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  });

  it("returns the trimmed style descriptor from the vision model", async () => {
    mockInvoke.mockResolvedValueOnce({
      content: "  warm cinematic palette, soft rim light  ",
    });
    const out = await describeImageStyle("aGVsbG8=", "image/png");
    expect(out).toBe("warm cinematic palette, soft rim light");
  });

  it("returns null when the SDK throws", async () => {
    mockInvoke.mockRejectedValueOnce(new Error("rate limited"));
    const out = await describeImageStyle("aGVsbG8=", "image/png");
    expect(out).toBeNull();
  });

  it("returns null when the model returns empty content", async () => {
    mockInvoke.mockResolvedValueOnce({ content: "   " });
    const out = await describeImageStyle("aGVsbG8=", "image/png");
    expect(out).toBeNull();
  });

  it("returns null (without calling the model) when OPENAI_API_KEY is unset", async () => {
    delete process.env.OPENAI_API_KEY;
    const out = await describeImageStyle("aGVsbG8=", "image/png");
    expect(out).toBeNull();
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("caps the descriptor to ~300 chars", async () => {
    mockInvoke.mockResolvedValueOnce({ content: "x".repeat(1000) });
    const out = await describeImageStyle("aGVsbG8=", "image/png");
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(300);
  });

  it("sends the image as a data URL with the given mime type", async () => {
    mockInvoke.mockResolvedValueOnce({ content: "muted earthy tones" });
    await describeImageStyle("QUJD", "image/jpeg");
    expect(mockInvoke).toHaveBeenCalledTimes(1);
    // invoke is called with an array of messages; unwrap the first message.
    const arg = mockInvoke.mock.calls[0]![0];
    const message = Array.isArray(arg) ? arg[0] : arg;
    // HumanMessage with array content: [{type:text}, {type:image_url, image_url:{url}}]
    const content = (message as { content: Array<Record<string, unknown>> }).content;
    expect(Array.isArray(content)).toBe(true);
    const imagePart = content.find((p) => p.type === "image_url") as
      | { image_url: { url: string } }
      | undefined;
    expect(imagePart?.image_url.url).toBe("data:image/jpeg;base64,QUJD");
  });
});
