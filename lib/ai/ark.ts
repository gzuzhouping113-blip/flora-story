import { env, assertArkReady } from "@/lib/env";
import { loadImagePrompt, loadVisionPrompt } from "@/lib/prompts";
import { aiAnalysisSchema, type AiAnalysis, type GenerateRecordRequest, type Style } from "@/lib/validation";
import { localImageUrlToDataUrl, mirrorRemoteImageToStorage } from "@/lib/storage";

function absoluteImageUrl(url: string) {
  if (/^https?:\/\//i.test(url)) return url;
  return `${env.publicAppUrl}${url.startsWith("/") ? url : `/${url}`}`;
}

async function arkImageInput(url: string) {
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

function extractResponseText(data: unknown): string {
  const obj = data as {
    output_text?: string;
    output?: Array<{
      content?: Array<{ text?: string; type?: string }>;
    }>;
    choices?: Array<{
      message?: { content?: string | Array<{ text?: string }> };
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
  throw new Error("豆包视觉模型返回为空。");
}

export async function analyzeBouquetWithArk(input: GenerateRecordRequest): Promise<AiAnalysis> {
  assertArkReady();
  const prompt = await loadVisionPrompt({
    time: input.recordDate,
    story: input.story
  });
  const imageUrl = await arkImageInput(input.originalImageUrl);

  const response = await fetch(`${env.arkBaseUrl}/responses`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.arkApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.arkVisionModel,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_image",
              image_url: imageUrl
            },
            {
              type: "input_text",
              text: prompt
            }
          ]
        }
      ],
      text: { format: { type: "json_object" } }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`豆包视觉识别失败：${response.status} ${errorText}`);
  }

  const raw = await response.json();
  const text = stripJsonFence(extractResponseText(raw));
  const parsed = JSON.parse(text);
  return aiAnalysisSchema.parse(parsed);
}

export async function generateImageWithArk(input: {
  originalImageUrl: string;
  style: Exclude<Style, "original">;
}) {
  assertArkReady();
  const prompt = await loadImagePrompt(input.style);
  const imageUrl = await arkImageInput(input.originalImageUrl);
  const response = await fetch(`${env.arkBaseUrl}/images/generations`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.arkApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: env.arkImageModel,
      prompt,
      image: imageUrl,
      sequential_image_generation: "disabled",
      response_format: "url",
      size: "2K",
      stream: false,
      watermark: false
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`豆包图生图失败：${response.status} ${errorText}`);
  }

  const payload = await response.json() as {
    data?: Array<{ url?: string; b64_json?: string }>;
  };
  const generatedUrl = payload.data?.[0]?.url;
  if (!generatedUrl) {
    throw new Error("豆包图生图没有返回图片 URL。");
  }
  return mirrorRemoteImageToStorage(generatedUrl);
}
