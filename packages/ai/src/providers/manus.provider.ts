/**
 * Manus AI provider — uses the Manus OpenAI-compatible REST API.
 * Endpoint: https://api.manus.im/v1
 * Model: manus-1
 * Env: MANUS_API_KEY
 *
 * Manus doesn't use LangChain; we call the API directly like Gemini.
 */

interface ManusMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ManusCompletionOptions {
  temperature?: number;
  maxTokens?: number;
}

const MANUS_BASE_URL = "https://api.manus.im/v1";
const MANUS_MODEL = "manus-1";

function getApiKey(): string {
  const key = process.env.MANUS_API_KEY;
  if (!key) {
    throw new Error(
      "Manus API key not found. Set MANUS_API_KEY in your environment."
    );
  }
  return key;
}

/**
 * Call Manus AI for text generation (single prompt).
 */
export async function callManus(
  prompt: string,
  options: ManusCompletionOptions = {}
): Promise<string> {
  const messages: ManusMessage[] = [{ role: "user", content: prompt }];
  return callManusChat(messages, options);
}

/**
 * Call Manus AI with a full message array (chat completions).
 */
export async function callManusChat(
  messages: ManusMessage[],
  options: ManusCompletionOptions = {}
): Promise<string> {
  const apiKey = getApiKey();

  const response = await fetch(`${MANUS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MANUS_MODEL,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error");
    throw new Error(
      `Manus API error (${response.status}): ${errorBody}`
    );
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  return data.choices?.[0]?.message?.content ?? "";
}

/**
 * Stream Manus AI responses. Returns an async generator yielding text chunks.
 */
export async function* streamManus(
  messages: ManusMessage[],
  options: ManusCompletionOptions = {}
): AsyncGenerator<string> {
  const apiKey = getApiKey();

  const response = await fetch(`${MANUS_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: MANUS_MODEL,
      messages,
      temperature: options.temperature ?? 0.7,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "Unknown error");
    throw new Error(`Manus API error (${response.status}): ${errorBody}`);
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("Manus API returned no response body");
  }

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data) as {
            choices: Array<{ delta: { content?: string } }>;
          };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // Skip malformed chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
