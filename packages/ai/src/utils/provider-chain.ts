/**
 * Shared text-provider fallback chain: [chosen → deepseek → openai → anthropic],
 * deduped, skipping providers whose API keys are absent from the environment.
 * With no provider chosen it is [deepseek → openai → anthropic].
 *
 * DeepSeek FIRST (owner decision 2026-10-09; it was the last hop from
 * 2026-09-28): every AI text feature defaults to DeepSeek, and DeepSeek is the
 * first fallback when a provider the user explicitly picked fails. With no
 * DEEPSEEK_API_KEY (an unplumbed compose key arrives as "") it is skipped and
 * the chain is [chosen → openai → anthropic].
 * The Super Agent chat does NOT use this chain — it has its own order
 * (Anthropic → DeepSeek → …) in apps/web/app/api/chat/stream/route.ts.
 * Always returns at least one entry (the chosen provider) so callers get a
 * meaningful provider error rather than a silent empty loop.
 *
 * This is the same policy as the repurpose router's local closure (A0 fix,
 * d2d5c47): when the chosen provider is dead (billing hold / quota / unset
 * key), fall through to the next configured provider instead of hard-failing.
 */
export function buildTextProviderChain(chosen: string | undefined): string[] {
  const safe = chosen || "deepseek";
  const configured: Record<string, boolean> = {
    openai: !!process.env.OPENAI_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    gemini: !!(process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY),
    gemma4: !!(process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY),
    grok: !!process.env.XAI_API_KEY,
    deepseek: !!process.env.DEEPSEEK_API_KEY,
  };
  const seen = new Set<string>();
  const chain = [safe, "deepseek", "openai", "anthropic"].filter((p) => {
    if (seen.has(p)) return false;
    seen.add(p);
    return configured[p] ?? true; // unknown providers (e.g. in tests) pass through
  });
  return chain.length > 0 ? chain : [safe];
}

/**
 * Run `fn` against each provider in the chain until one succeeds; throw the
 * last error only after the whole chain is exhausted. `onFallback` (optional)
 * is invoked before each retry hop — use it for logging/progress reporting.
 */
export async function withTextProviderFallback<T>(
  chosen: string | undefined,
  fn: (provider: string) => Promise<T>,
  onFallback?: (failedProvider: string, nextProvider: string, error: unknown) => void,
): Promise<T> {
  const chain = buildTextProviderChain(chosen);
  let lastErr: unknown;
  for (let i = 0; i < chain.length; i++) {
    try {
      return await fn(chain[i]!);
    } catch (e) {
      lastErr = e;
      if (i < chain.length - 1) onFallback?.(chain[i]!, chain[i + 1]!, e);
    }
  }
  throw lastErr;
}
