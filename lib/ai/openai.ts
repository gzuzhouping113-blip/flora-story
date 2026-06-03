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
  const obj = data as {
    output_text?: string;
    output?: Array<{
      content?: Array<{ text?: string; type?: string }>;
    }>;
    choices?: Array<{
      message?: { content?: string | Array<{ text?: string; type?: string }> };
    }>;
  };

  if (obj.output_text) return obj.output_text;
  const outputText = obj.output?.flatMap(item => item.content || []).map(item => item.text).filter(Boolean).join("");
  if (outputText) return outputText;

  const content = obj.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(item => item.text || "").join("");
  }

  throw new Error("Vision model returned empty content.");
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

export async function analyzeBouquetWithOpenAI(input: GenerateRecordRequest): Promise<AiAnalysis> {
  assertOpenAiVisionReady();
  const prompt = await loadVisionPrompt({
    time: input.recordDate,
    story: input.story
  });
  const imageUrl = await openAiImageInput(input.originalImageUrl);

  const responsesBody = {
    model: env.openAiVisionModel,
    input: [
      {
        role: "user",
        content: [
          { type: "input_image", image_url: imageUrl, detail: "high" },
          { type: "input_text", text: prompt }
        ]
      }
    ],
    text: { format: { type: "json_object" } }
  };

  try {
    const raw = await withRetry(() => fetchJsonWithTimeout({
      url: `${env.openAiBaseUrl}/responses`,
      apiKey: env.openAiVisionApiKey,
      body: responsesBody,
      timeoutMs: 90_000
    }), 7, 800);
    return aiAnalysisSchema.parse(parseLooseJson(extractResponseText(raw)));
  } catch (responsesError) {
    const chatBody = {
      model: env.openAiVisionModel,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            { type: "image_url", image_url: { url: imageUrl, detail: "high" } }
          ]
        }
      ],
      response_format: { type: "json_object" }
    };

    try {
      const raw = await withRetry(() => fetchJsonWithTimeout({
        url: `${env.openAiBaseUrl}/chat/completions`,
        apiKey: env.openAiVisionApiKey,
        body: chatBody,
        timeoutMs: 90_000
      }));
      return aiAnalysisSchema.parse(parseLooseJson(extractResponseText(raw)));
    } catch (chatError) {
      const first = responsesError instanceof Error ? responsesError.message : String(responsesError);
      const second = chatError instanceof Error ? chatError.message : String(chatError);
      throw new Error(`GPT vision failed: ${first}; ${second}`);
    }
  }
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
