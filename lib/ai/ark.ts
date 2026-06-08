import { assertArkReady, env } from "@/lib/env";
import { loadImagePrompt, loadVisionPrompt } from "@/lib/prompts";
import { aiAnalysisSchema, type AiAnalysis, type GenerateRecordRequest, type Style } from "@/lib/validation";
import { localImageUrlToDataUrl, mirrorRemoteImageToStorage, saveGeneratedImageDataUrl } from "@/lib/storage";

const arkVisionTimeoutMs = 45_000;
const arkImageTimeoutMs = 105_000;

type JsonObject = Record<string, unknown>;

function absoluteImageUrl(url: string) {
  if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return url;
  return `${env.publicAppUrl}${url.startsWith("/") ? url : `/${url}`}`;
}

async function arkImageInput(url: string) {
  return await localImageUrlToDataUrl(url) || absoluteImageUrl(url);
}

async function fetchArkJson(input: { url: string; body: unknown; timeoutMs: number }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.arkApiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(input.body),
      signal: controller.signal
    });

    const text = await response.text();
    let data: unknown = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      throw new Error(`Ark API failed: ${response.status} ${text.slice(0, 800)}`);
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Ark API request timed out after ${Math.round(input.timeoutMs / 1000)}s.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function stripJsonFence(text: string) {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function extractResponseText(data: unknown): string {
  const normalizeContent = (content: unknown): string => {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map(item => {
        if (!item) return "";
        if (typeof item === "string") return item;
        const obj = item as { text?: unknown; content?: unknown; output_text?: unknown };
        return normalizeContent(obj.text || obj.content || obj.output_text);
      }).join("");
    }
    if (typeof content === "object") {
      const obj = content as { text?: unknown; content?: unknown; output_text?: unknown };
      return normalizeContent(obj.text || obj.content || obj.output_text);
    }
    return String(content);
  };

  const obj = data as {
    output_text?: string;
    text?: string;
    content?: unknown;
    result?: string;
    raw?: string;
    output?: Array<{ content?: Array<{ text?: string; content?: string }> }>;
    choices?: Array<{ message?: { content?: string | Array<{ text?: string; content?: string }> } }>;
  };

  if (obj.output_text) {
    const outputText = normalizeContent(obj.output_text);
    if (outputText) return outputText;
  }
  if (obj.text) {
    const text = normalizeContent(obj.text);
    if (text) return text;
  }
  if (obj.content) {
    const contentText = normalizeContent(obj.content);
    if (contentText) return contentText;
  }
  if (obj.result) {
    const result = normalizeContent(obj.result);
    if (result) return result;
  }
  if (obj.raw) {
    const raw = normalizeContent(obj.raw);
    if (raw) return raw;
  }

  const outputText = obj.output
    ?.flatMap(item => item.content || [])
    .map(item => item.text || item.content)
    .filter(Boolean)
    .join("");
  if (outputText) return outputText;

  const content = normalizeContent(obj.choices?.[0]?.message?.content);
  if (content) return content;

  throw new Error("Ark vision model returned empty content.");
}

function parseVisionJson(payload: unknown) {
  const text = stripJsonFence(extractResponseText(payload));
  try {
    return JSON.parse(text);
  } catch {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) return JSON.parse(text.slice(first, last + 1));
    throw new Error("Ark vision model returned invalid JSON.");
  }
}

export async function analyzeBouquetWithArk(input: GenerateRecordRequest & { recentTitles?: string[] }): Promise<AiAnalysis> {
  assertArkReady();
  const prompt = await loadVisionPrompt({
    time: input.recordDate,
    story: input.story,
    recentTitles: input.recentTitles
  });
  const imageUrl = await arkImageInput(input.originalImageUrl);

  const raw = await fetchArkJson({
    url: `${env.arkBaseUrl}/responses`,
    timeoutMs: arkVisionTimeoutMs,
    body: {
      model: env.arkVisionModel,
      input: [
        {
          role: "user",
          content: [
            { type: "input_image", image_url: imageUrl },
            { type: "input_text", text: prompt }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    }
  });

  return aiAnalysisSchema.parse(parseVisionJson(raw));
}

export async function generateImageWithArk(input: {
  originalImageUrl: string;
  style: Exclude<Style, "original">;
}) {
  assertArkReady();
  const prompt = await loadImagePrompt(input.style);
  const imageUrl = await arkImageInput(input.originalImageUrl);
  const payload = await fetchArkJson({
    url: `${env.arkBaseUrl}/images/generations`,
    timeoutMs: arkImageTimeoutMs,
    body: {
      model: env.arkImageModel,
      prompt,
      image: imageUrl,
      sequential_image_generation: "disabled",
      response_format: "url",
      size: "2K",
      stream: false,
      watermark: false
    }
  }) as {
    data?: Array<{ url?: string; b64_json?: string }>;
    images?: Array<{ url?: string; b64_json?: string }>;
    url?: string;
    b64_json?: string;
    image?: string;
  };

  const candidate = payload.data?.[0] || payload.images?.[0] || payload;
  const b64Json = candidate.b64_json || (typeof payload.image === "string" && !/^https?:\/\//i.test(payload.image) ? payload.image : "");
  const generatedUrl = candidate.url || (typeof payload.image === "string" && /^https?:\/\//i.test(payload.image) ? payload.image : "");

  if (b64Json) {
    return saveGeneratedImageDataUrl(b64Json.startsWith("data:") ? b64Json : `data:image/png;base64,${b64Json}`);
  }
  if (generatedUrl) {
    if (generatedUrl.startsWith("data:")) return saveGeneratedImageDataUrl(generatedUrl);
    return mirrorRemoteImageToStorage(generatedUrl);
  }

  throw new Error("Ark image API did not return a usable image.");
}
