// Claude API for diagnosis (ADR 0006). The only place ANTHROPIC_API_KEY is read, and only the
// worker calls it: the dashboard never holds the key (architecture §2). One request per diagnosis:
// cached system prompt and app source, the untrusted log data last, and the answer constrained to
// the diagnosis JSON schema. A refusal or a cut-off answer is a failure, never a partial result.
import Anthropic from "@anthropic-ai/sdk";

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface ModelRequest {
  model: string;
  effort: "low" | "medium" | "high";
  /** Fixed instructions (cached). */
  system: string;
  /** App source and guides (cached). */
  cachedContext: string;
  /** Incident metadata and the untrusted log data (not cached). */
  untrusted: string;
  schema: Record<string, unknown>;
}

export type ModelResponse =
  | { ok: true; text: string; model: string; usage: ModelUsage }
  | { ok: false; error: string; model: string; usage: ModelUsage | null };

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

const MAX_TOKENS = 16_000;
const TIMEOUT_MS = 180_000;

export function anthropicConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function toUsage(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null }): ModelUsage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
  };
}

/** A short, secret-free description of an API failure (status and type, never the request). */
function describeError(err: unknown): string {
  if (err instanceof Anthropic.APIError) return `Claude API error${err.status ? ` HTTP ${err.status}` : ""} (${err.name})`;
  const e = err as { name?: string };
  return `Claude API call failed (${e?.name ?? "Error"})`;
}

/** The real client, or null when no key is configured (the worker then skips diagnosis). */
export function anthropicClient(): ModelClient | null {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 1 });
  return {
    async complete(req) {
      try {
        const res = await client.beta.messages.create({
          model: req.model,
          max_tokens: MAX_TOKENS,
          // If a safety classifier declines, the API re-runs the request on a fallback model.
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: req.cachedContext, cache_control: { type: "ephemeral" } },
                { type: "text", text: req.untrusted },
              ],
            },
          ],
          output_config: { effort: req.effort, format: { type: "json_schema", schema: req.schema } },
        });
        const usage = toUsage(res.usage);
        if (res.stop_reason === "refusal") {
          return { ok: false, error: `Claude declined (${res.stop_details?.category ?? "no category"})`, model: res.model, usage };
        }
        if (res.stop_reason === "max_tokens") return { ok: false, error: "the answer was cut off (max_tokens)", model: res.model, usage };
        const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
        return { ok: true, text, model: res.model, usage };
      } catch (err) {
        return { ok: false, error: describeError(err), model: req.model, usage: null };
      }
    },
  };
}
