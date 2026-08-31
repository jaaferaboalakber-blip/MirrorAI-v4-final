import { GoogleGenAI } from "@google/genai";

export const GEMINI_MODEL = "gemini-3.6-flash";
export const GROQ_MODEL = "llama-3.3-70b-versatile";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions";
const MAX_OUTPUT_TOKENS = 8192;

type GeminiClient = {
  models: {
    generateContent(input: Record<string, unknown>): Promise<{ text?: string }>;
  };
};

type ProviderName = "Gemini" | "Groq";

type ProviderErrorDetails = {
  status?: number;
  code?: string;
};

export class AiProviderError extends Error {
  readonly provider: ProviderName;
  readonly status?: number;
  readonly code?: string;

  constructor(provider: ProviderName, message: string, details: ProviderErrorDetails = {}) {
    super(message);
    this.name = "AiProviderError";
    this.provider = provider;
    this.status = details.status;
    this.code = details.code;
  }
}

export class AiFallbackError extends Error {
  readonly primaryError: AiProviderError;
  readonly fallbackError: AiProviderError;

  constructor(primaryError: AiProviderError, fallbackError: AiProviderError) {
    super("Gemini failed and Groq fallback failed.");
    this.name = "AiFallbackError";
    this.primaryError = primaryError;
    this.fallbackError = fallbackError;
  }
}

type ProviderDependencies = {
  getGeminiClient?: () => GeminiClient | null;
  fetchImpl?: typeof fetch;
  groqModel?: string;
};

function getGeminiClient(): GeminiClient | null {
  const apiKey = process.env.GEMINI_API_KEY;
  return apiKey ? (new GoogleGenAI({ apiKey }) as unknown as GeminiClient) : null;
}

function getErrorStatus(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const typed = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  const value = typed.status ?? typed.statusCode
    ?? (typeof typed.code === "number" ? typed.code : undefined);
  const status = Number(value);
  return Number.isFinite(status) && status > 0 ? status : undefined;
}

function getErrorCode(error: unknown) {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

function getErrorText(error: unknown) {
  if (!error || typeof error !== "object") return String(error ?? "");
  const typed = error as {
    name?: unknown;
    message?: unknown;
    status?: unknown;
    code?: unknown;
    cause?: { name?: unknown; message?: unknown; code?: unknown };
  };
  return [
    typed.name,
    typed.message,
    typed.status,
    typed.code,
    typed.cause?.name,
    typed.cause?.message,
    typed.cause?.code,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function isFallbackEligibleError(error: unknown) {
  const status = getErrorStatus(error);
  if ([400, 401, 403, 404].includes(status || 0)) return false;
  if ([429, 502, 503, 504].includes(status || 0)) return true;

  const text = getErrorText(error);
  if (/(^|\D)(429|502|503|504)(\D|$)/.test(text)) return true;
  return [
    "resource_exhausted",
    "quota",
    "rate limit",
    "rate_limit",
    "rate limited",
    "too many requests",
    "econnreset",
    "etimedout",
    "econnrefused",
    "eai_again",
    "fetch failed",
  ].some((marker) => text.includes(marker));
}

function normalizeError(provider: ProviderName, error: unknown) {
  if (error instanceof AiProviderError) return error;
  const status = getErrorStatus(error);
  const code = getErrorCode(error);
  const message = error instanceof Error ? error.message : String(error || "Unknown provider error");
  return new AiProviderError(provider, message, { status, code });
}

function parseGroqError(payload: unknown, status: number) {
  if (payload && typeof payload === "object") {
    const error = (payload as { error?: unknown }).error;
    if (error && typeof error === "object") {
      const code = typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : undefined;
      const message = typeof (error as { message?: unknown }).message === "string"
        ? (error as { message: string }).message
        : "Groq request failed.";
      return new AiProviderError("Groq", message, { status, code });
    }
  }
  return new AiProviderError("Groq", "Groq request failed.", { status });
}

async function generateWithGroq(
  prompt: string,
  json: boolean,
  fetchImpl: typeof fetch,
  model: string,
) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new AiProviderError("Groq", "GROQ_API_KEY is not configured.", { code: "missing_api_key" });
  }

  const response = await fetchImpl(GROQ_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) throw parseGroqError(payload, response.status);

  const text = payload
    && typeof payload === "object"
    && Array.isArray((payload as { choices?: unknown }).choices)
    && (payload as { choices: Array<{ message?: { content?: unknown } }> }).choices[0]?.message?.content;

  if (typeof text !== "string") {
    throw new AiProviderError("Groq", "Groq returned no text.", { code: "invalid_response" });
  }
  return text;
}

export function createAiProvider(dependencies: ProviderDependencies = {}) {
  const getClient = dependencies.getGeminiClient || getGeminiClient;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch.bind(globalThis);
  const groqModel = dependencies.groqModel || GROQ_MODEL;

  return {
    async generate(prompt: string, json = false) {
      const geminiClient = getClient();
      const hasGroq = Boolean(process.env.GROQ_API_KEY);

      if (!geminiClient) {
        if (!hasGroq) {
          throw new AiProviderError(
            "Gemini",
            "No AI provider is configured.",
            { code: "missing_api_keys" },
          );
        }
        return generateWithGroq(prompt, json, fetchImpl, groqModel);
      }

      try {
        const response = await geminiClient.models.generateContent({
          model: GEMINI_MODEL,
          contents: prompt,
          config: json
            ? { responseMimeType: "application/json", maxOutputTokens: MAX_OUTPUT_TOKENS }
            : { maxOutputTokens: MAX_OUTPUT_TOKENS },
        });
        return response.text || "";
      } catch (error) {
        const primaryError = normalizeError("Gemini", error);
        if (!hasGroq || !isFallbackEligibleError(error)) throw primaryError;

        try {
          return await generateWithGroq(prompt, json, fetchImpl, groqModel);
        } catch (fallbackError) {
          throw new AiFallbackError(primaryError, normalizeError("Groq", fallbackError));
        }
      }
    },
  };
}

const defaultProvider = createAiProvider();

export function hasConfiguredProvider() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.GROQ_API_KEY);
}

export async function generate(prompt: string, json = false) {
  return defaultProvider.generate(prompt, json);
}

function formatProviderError(error: AiProviderError) {
  const status = error.status ? ` ${error.status}` : "";
  const code = error.code ? ` ${error.code}` : "";
  return `${error.provider}${status}${code}`;
}

export function summarizeAiError(error: unknown) {
  if (error instanceof AiFallbackError) {
    return `Gemini ثم Groq: ${formatProviderError(error.primaryError)}؛ ${formatProviderError(error.fallbackError)}`;
  }
  if (error instanceof AiProviderError) return formatProviderError(error);
  return "خطأ غير مصنف من مزود الذكاء الاصطناعي";
}
