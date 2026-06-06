import { assertOpenAiImageReady, assertOpenAiVisionReady, env } from "@/lib/env";
import { loadImagePrompt, loadVisionPrompt } from "@/lib/prompts";
import {
  aiAnalysisSchema,
  type AiAnalysis,
  type GenerateRecordRequest,
  type Style
} from "@/lib/validation";
import {
  localImageUrlToDataUrl,
  mirrorRemoteImageToStorage,
  saveGeneratedImageDataUrl
} from "@/lib/storage";

type JsonObject = Record<string, unknown>;

const flowerAnalysisJsonSchema = {
  name: "flower_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["flower_details", "comment", "title"],
    properties: {
      flower_details: {
        type: "array",
        minItems: 1,
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "meaning"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 24 },
            meaning: { type: "string", minLength: 1, maxLength: 40 }
          }
        }
      },
      comment: { type: "string", minLength: 1, maxLength: 40 },
      title: { type: "string", minLength: 1, maxLength: 12 }
    }
  }
};

function absoluteImageUrl(url: string) {
  if (/^https?:\/\//i.test(url) || url.startsWith("data:")) return url;
  return `${env.publicAppUrl}${url.startsWith("/") ? url : `/${url}`}`;
}

async function openAiImageInput(url: string) {
  return await localImageUrlToDataUrl(url) || absoluteImageUrl(url);
}

function stripJsonFence(text: string) {
  return text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseLooseJson(text: string) {
  const stripped = stripJsonFence(text);
  try {
    return JSON.parse(stripped);
  } catch {
    const first = stripped.indexOf("{");
    const last = stripped.lastIndexOf("}");
    if (first >= 0 && last > first) {
      return JSON.parse(stripped.slice(first, last + 1));
    }
    throw new Error("Vision model returned invalid JSON.");
  }
}

function extractResponseText(data: unknown): string {
  if (typeof data === "string") return data;

  const obj = data as {
    output_text?: string;
    text?: string;
    content?: string;
    result?: string;
    raw?: string;
    output?: Array<{
      content?: Array<{ text?: string; type?: string; content?: string }>;
    }>;
    choices?: Array<{
      text?: string;
      message?: { content?: string | Array<{ text?: string; type?: string; content?: string }> };
    }>;
  };

  if (obj.output_text) return obj.output_text;
  if (obj.text) return obj.text;
  if (obj.content) return obj.content;
  if (obj.result) return obj.result;
  if (obj.raw) return obj.raw;

  const outputText = obj.output
    ?.flatMap(item => item.content || [])
    .map(item => item.text || item.content)
    .filter(Boolean)
    .join("");
  if (outputText) return outputText;

  if (obj.choices?.[0]?.text) return obj.choices[0].text;

  const content = obj.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(item => item.text || item.content || "").join("");
  }

  throw new Error("Vision model returned empty content.");
}

function parseSsePayload(text: string) {
  const chunks = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith("data:"))
    .map(line => line.replace(/^data:\s*/, "").trim())
    .filter(line => line && line !== "[DONE]");

  if (chunks.length === 0) return null;

  const parsedChunks = chunks.map(chunk => {
    try {
      return JSON.parse(chunk);
    } catch {
      return { raw: chunk };
    }
  });

  const textParts = parsedChunks.flatMap(chunk => {
    const obj = chunk as {
      output_text?: string;
      choices?: Array<{
        text?: string;
        delta?: { content?: string | Array<{ text?: string; content?: string }> };
        message?: { content?: string | Array<{ text?: string; content?: string }> };
      }>;
    };
    const choice = obj.choices?.[0];
    const contents = [
      obj.output_text,
      choice?.text,
      choice?.delta?.content,
      choice?.message?.content
    ];
    return contents.flatMap(content => {
      if (!content) return [];
      if (typeof content === "string") return [content];
      return content.map(item => item.text || item.content || "").filter(Boolean);
    });
  });

  const combinedText = textParts.join("");
  if (combinedText.trim()) return { text: combinedText, empty: false };
  return { text: "", empty: true };
}

function extractVisionText(payload: unknown) {
  if (typeof payload === "object" && payload && "raw" in payload && typeof (payload as JsonObject).raw === "string") {
    const raw = String((payload as JsonObject).raw);
    const ssePayload = parseSsePayload(raw);
    if (ssePayload?.text) return ssePayload.text;
    if (ssePayload?.empty) {
      throw new Error("Vision model returned SSE chunks without assistant content.");
    }
  }

  return extractResponseText(payload);
}

async function fetchJsonWithTimeout(input: {
  url: string;
  apiKey: string;
  body?: unknown;
  formData?: FormData;
  timeoutMs: number;
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        ...(input.formData ? {} : { "Content-Type": "application/json" })
      },
      body: input.formData || JSON.stringify(input.body),
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
      const message = typeof data === "object" && data && "error" in data
        ? JSON.stringify((data as JsonObject).error)
        : text;
      throw new Error(`GPT API failed: ${response.status} ${message}`);
    }
    return data;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("GPT API request timed out.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function withRetry<T>(fn: () => Promise<T>, retries = 1, delayMs = 1200) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt < retries) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

async function withVisionRetry<T>(label: string, fn: () => Promise<T>, retries = 3, delayMs = 900) {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const isUnsupportedFormat = /response_format|json_schema|unsupported|not support/i.test(message)
        && /failed:\s*4\d\d|400|422/i.test(message);
      if (attempt >= retries || isUnsupportedFormat) break;
      await new Promise(resolve => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${label}: ${message}`);
}

async function parseVisionPayload(payload: unknown) {
  return aiAnalysisSchema.parse(parseLooseJson(extractVisionText(payload)));
}

function parseDataUrl(dataUrl: string) {
  const match = dataUrl.match(/^data:([^;,]+);base64,(.+)$/);
  if (!match) return null;
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], "base64")
  };
}

async function imageFileFromUrl(url: string) {
  const dataUrl = await localImageUrlToDataUrl(url);
  const parsed = dataUrl ? parseDataUrl(dataUrl) : null;
  if (parsed) {
    return new File([parsed.buffer], "flower-reference.png", { type: parsed.mimeType });
  }

  const response = await fetch(absoluteImageUrl(url));
  if (!response.ok) {
    throw new Error(`Reference image download failed: ${response.status}`);
  }
  const mimeType = response.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());
  return new File([buffer], `flower-reference.${mimeType.includes("png") ? "png" : "jpg"}`, { type: mimeType });
}

async function persistImagePayload(payload: unknown) {
  const obj = payload as {
    data?: Array<{ url?: string; b64_json?: string }>;
    url?: string;
    b64_json?: string;
    image?: string;
    images?: Array<{ url?: string; b64_json?: string }>;
  };

  const candidate = obj.data?.[0] || obj.images?.[0] || obj;
  const b64Json = candidate.b64_json || (typeof obj.image === "string" && !/^https?:\/\//i.test(obj.image) ? obj.image : "");
  const imageUrl = candidate.url || (typeof obj.image === "string" && /^https?:\/\//i.test(obj.image) ? obj.image : "");

  if (b64Json) {
    return saveGeneratedImageDataUrl(b64Json.startsWith("data:") ? b64Json : `data:image/png;base64,${b64Json}`);
  }
  if (imageUrl) {
    if (imageUrl.startsWith("data:")) return saveGeneratedImageDataUrl(imageUrl);
    return mirrorRemoteImageToStorage(imageUrl);
  }

  throw new Error("GPT image API did not return a usable image.");
}

export async function analyzeBouquetWithOpenAI(input: GenerateRecordRequest & { recentTitles?: string[] }): Promise<AiAnalysis> {
  assertOpenAiVisionReady();
  const prompt = await loadVisionPrompt({
    time: input.recordDate,
    story: input.story,
    recentTitles: input.recentTitles
  });
  const imageUrl = await openAiImageInput(input.originalImageUrl);
  const chatMessages = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
      ]
    }
  ];
  const responsesInput = [
    {
      role: "user",
      content: [
        { type: "input_image", image_url: imageUrl, detail: "high" },
        { type: "input_text", text: prompt }
      ]
    }
  ];

  const attempts: Array<{ label: string; run: () => Promise<AiAnalysis> }> = [
    {
      label: "chat/completions plain",
      run: async () => parseVisionPayload(await fetchJsonWithTimeout({
        url: `${env.openAiBaseUrl}/chat/completions`,
        apiKey: env.openAiVisionApiKey,
        body: {
          model: env.openAiVisionModel,
          messages: chatMessages,
          stream: false,
          temperature: 0,
          max_tokens: 600
        },
        timeoutMs: 90_000
      }))
    },
    {
      label: "chat/completions json_object",
      run: async () => parseVisionPayload(await fetchJsonWithTimeout({
        url: `${env.openAiBaseUrl}/chat/completions`,
        apiKey: env.openAiVisionApiKey,
        body: {
          model: env.openAiVisionModel,
          messages: chatMessages,
          stream: false,
          temperature: 0,
          max_tokens: 600,
          response_format: { type: "json_object" }
        },
        timeoutMs: 90_000
      }))
    },
    {
      label: "chat/completions json_schema",
      run: async () => parseVisionPayload(await fetchJsonWithTimeout({
        url: `${env.openAiBaseUrl}/chat/completions`,
        apiKey: env.openAiVisionApiKey,
        body: {
          model: env.openAiVisionModel,
          messages: chatMessages,
          stream: false,
          temperature: 0,
          max_tokens: 600,
          response_format: {
            type: "json_schema",
            json_schema: flowerAnalysisJsonSchema
          }
        },
        timeoutMs: 90_000
      }))
    },
    {
      label: "responses json_object",
      run: async () => parseVisionPayload(await fetchJsonWithTimeout({
        url: `${env.openAiBaseUrl}/responses`,
        apiKey: env.openAiVisionApiKey,
        body: {
          model: env.openAiVisionModel,
          input: responsesInput,
          text: { format: { type: "json_object" } }
        },
        timeoutMs: 90_000
      }))
    },
    {
      label: "responses plain",
      run: async () => parseVisionPayload(await fetchJsonWithTimeout({
        url: `${env.openAiBaseUrl}/responses`,
        apiKey: env.openAiVisionApiKey,
        body: {
          model: env.openAiVisionModel,
          input: responsesInput
        },
        timeoutMs: 90_000
      }))
    }
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      return await withVisionRetry(attempt.label, attempt.run, 3, 900);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  throw new Error(`GPT vision failed: ${errors.join(" | ")}`);
}

export async function generateImageWithOpenAI(input: {
  originalImageUrl: string;
  style: Exclude<Style, "original">;
}) {
  assertOpenAiImageReady();
  const prompt = await loadImagePrompt(input.style);
  const imageUrl = await openAiImageInput(input.originalImageUrl);
  const errors: string[] = [];

  const attempts: Array<{ label: string; run: () => Promise<unknown> }> = [
    {
      label: "images/edits multipart",
      run: async () => {
        const formData = new FormData();
        formData.append("model", env.openAiImageModel);
        formData.append("prompt", prompt);
        formData.append("image", await imageFileFromUrl(input.originalImageUrl));
        formData.append("size", "1024x1536");
        formData.append("n", "1");
        return fetchJsonWithTimeout({
          url: `${env.openAiBaseUrl}/images/edits`,
          apiKey: env.openAiImageApiKey,
          formData,
          timeoutMs: 180_000
        });
      }
    },
    {
      label: "images/edits multipart full",
      run: async () => {
        const formData = new FormData();
        formData.append("model", env.openAiImageModel);
        formData.append("prompt", prompt);
        formData.append("image", await imageFileFromUrl(input.originalImageUrl));
        formData.append("n", "1");
        formData.append("size", "1024x1536");
        formData.append("quality", "medium");
        formData.append("background", "opaque");
        formData.append("output_format", "png");
        return fetchJsonWithTimeout({
          url: `${env.openAiBaseUrl}/images/edits`,
          apiKey: env.openAiImageApiKey,
          formData,
          timeoutMs: 180_000
        });
      }
    },
    {
      label: "images/edits json compatibility",
      run: () => fetchJsonWithTimeout({
        url: `${env.openAiBaseUrl}/images/edits`,
        apiKey: env.openAiImageApiKey,
        body: {
          model: env.openAiImageModel,
          prompt,
          images: [{ image_url: imageUrl }],
          n: 1,
          size: "1024x1536",
          quality: "medium",
          background: "opaque",
          output_format: "png"
        },
        timeoutMs: 180_000
      })
    },
    {
      label: "images/generations compatibility",
      run: () => fetchJsonWithTimeout({
        url: `${env.openAiBaseUrl}/images/generations`,
        apiKey: env.openAiImageApiKey,
        body: {
          model: env.openAiImageModel,
          prompt,
          image: imageUrl,
          response_format: "b64_json",
          n: 1,
          size: "1024x1536",
          quality: "medium"
        },
        timeoutMs: 180_000
      })
    }
  ];

  for (const attempt of attempts) {
    try {
      const payload = await attempt.run();
      return await persistImagePayload(payload);
    } catch (error) {
      errors.push(`${attempt.label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  throw new Error(`GPT image generation failed: ${errors.join(" | ")}`);
}
