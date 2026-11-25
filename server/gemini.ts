import {
  type Content,
  type FunctionDeclaration,
  type GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';

let cachedClient: GoogleGenAI | null = null;

const PRIMARY_MODEL = 'gemini-4-hydrogen';
const SECONDARY_MODEL = 'gemini-3.1-flash-lite';

export function isGeminiConfigured(): boolean {
  const key = process.env.GEMINI_API_KEY;
  return Boolean(key && key.trim().length > 0 && key !== 'MY_GEMINI_API_KEY');
}

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'MY_GEMINI_API_KEY') {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }

  if (!cachedClient) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }

  return cachedClient;
}

export function isTransientGeminiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return (
    message.includes('503') ||
    message.includes('429') ||
    message.includes('UNAVAILABLE') ||
    message.includes('RESOURCE_EXHAUSTED') ||
    message.toLowerCase().includes('high demand')
  );
}

export function summarizeGeminiError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  try {
    const parsed = JSON.parse(raw) as {
      error?: { code?: number; status?: string; message?: string };
    };
    if (parsed?.error?.message) {
      return `${parsed.error.code ?? ''} ${parsed.error.status ?? ''}: ${parsed.error.message}`.trim();
    }
  } catch {
    // ignore non-JSON error strings
  }
  return raw;
}

export function formatGeminiError(error: unknown, fallbackMessage: string): Error {
  const summary = summarizeGeminiError(error);
  if (isTransientGeminiError(error)) {
    return new Error(
      `Gemini API temporarily unavailable (${summary || 'high demand'}). Please retry in a few seconds.`
    );
  }
  return new Error(summary || fallbackMessage);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function generateContentWithRetry(params: {
  contents: string | Content[];
  systemInstruction: string;
  functionDeclarations?: FunctionDeclaration[];
}): Promise<GenerateContentResponse> {
  const ai = getGeminiClient();
  const attempts: Array<{ model: string; delayMs: number }> = [
    { model: PRIMARY_MODEL, delayMs: 0 },
    { model: PRIMARY_MODEL, delayMs: 2000 },
    { model: SECONDARY_MODEL, delayMs: 1000 },
    { model: PRIMARY_MODEL, delayMs: 3000 },
  ];

  let firstTransientError: unknown;
  let lastError: unknown;

  for (const attempt of attempts) {
    if (attempt.delayMs > 0) {
      await sleep(attempt.delayMs);
    }
    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents: params.contents,
        config: {
          systemInstruction: params.systemInstruction,
          ...(params.functionDeclarations && params.functionDeclarations.length > 0
            ? {
                tools: [{ functionDeclarations: params.functionDeclarations }],
              }
            : {}),
        },
      });
      return response;
    } catch (error) {
      lastError = error;
      if (!firstTransientError && isTransientGeminiError(error)) {
        firstTransientError = error;
      }
      console.warn(
        `[ForgeAI] Gemini attempt failed (${attempt.model}):`,
        summarizeGeminiError(error)
      );
      if (!isTransientGeminiError(error)) {
        throw formatGeminiError(error, 'Gemini request failed.');
      }
    }
  }

  throw formatGeminiError(
    firstTransientError ?? lastError,
    'Gemini request failed after retries.'
  );
}

export async function generateStructuredJson(
  prompt: string,
  systemInstruction: string,
  responseSchema: Record<string, unknown>
): Promise<string> {
  const ai = getGeminiClient();
  const attempts: Array<{ model: string; delayMs: number }> = [
    { model: PRIMARY_MODEL, delayMs: 0 },
    { model: PRIMARY_MODEL, delayMs: 2000 },
    { model: SECONDARY_MODEL, delayMs: 1000 },
    { model: PRIMARY_MODEL, delayMs: 3000 },
  ];

  let firstTransientError: unknown;
  let lastError: unknown;

  for (const attempt of attempts) {
    if (attempt.delayMs > 0) {
      await sleep(attempt.delayMs);
    }
    try {
      const response = await ai.models.generateContent({
        model: attempt.model,
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
        },
      });
      const rawText = (response.text ?? '').trim();
      if (!rawText) {
        throw new Error('Gemini returned an empty JSON response.');
      }
      return rawText;
    } catch (error) {
      lastError = error;
      if (!firstTransientError && isTransientGeminiError(error)) {
        firstTransientError = error;
      }
      console.warn(
        `[ForgeAI] Gemini attempt failed (${attempt.model}):`,
        summarizeGeminiError(error)
      );
      if (!isTransientGeminiError(error)) {
        throw formatGeminiError(error, 'Gemini request failed.');
      }
    }
  }

  throw formatGeminiError(
    firstTransientError ?? lastError,
    'Gemini request failed after retries.'
  );
}
