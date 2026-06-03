import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { analyzeBouquetWithArk, generateImageWithArk } from "@/lib/ai/ark";
import { analyzeBouquetWithOpenAI, generateImageWithOpenAI } from "@/lib/ai/openai";
import { mockAnalyzeBouquet, mockGeneratedImage } from "@/lib/ai/mock";
import { getCurrentUser } from "@/lib/auth";
import { generateRecordRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 300;

function fallbackAnalysis() {
  return {
    flower_details: [
      { name: "花束", meaning: "一束被认真记住的花" }
    ],
    comment: "这束花很会心动",
    title: "花开此刻"
  };
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再生成花束。" }, { status: 401 });
    }

    const input = generateRecordRequestSchema.parse(await request.json());
    const analysisPromise = env.aiProvider === "ark"
      ? analyzeBouquetWithArk(input)
      : env.aiProvider === "openai"
        ? analyzeBouquetWithOpenAI(input)
        : Promise.resolve(mockAnalyzeBouquet(input));

    const imagePromise = input.style === "original"
      ? Promise.resolve({ url: input.originalImageUrl, failed: false, error: "" })
      : (env.aiProvider === "ark"
          ? generateImageWithArk({
              originalImageUrl: input.originalImageUrl,
              style: input.style
            })
          : env.aiProvider === "openai"
            ? generateImageWithOpenAI({
                originalImageUrl: input.originalImageUrl,
                style: input.style
              })
            : Promise.resolve(mockGeneratedImage(input.originalImageUrl))
        )
        .then(url => ({ url, failed: false, error: "" }))
        .catch(error => ({
          url: input.originalImageUrl,
          failed: true,
          error: error instanceof Error ? error.message : String(error)
        }));

    const [analysisResult, imageResult] = await Promise.allSettled([analysisPromise, imagePromise]);
    const analysisFailed = analysisResult.status === "rejected";
    const analysis = analysisFailed ? fallbackAnalysis() : analysisResult.value;
    const image = imageResult.status === "fulfilled"
      ? imageResult.value
      : {
          url: input.originalImageUrl,
          failed: true,
          error: imageResult.reason instanceof Error ? imageResult.reason.message : String(imageResult.reason)
        };

    return NextResponse.json({
      ...analysis,
      originalImageUrl: input.originalImageUrl,
      generatedImageUrl: image.url,
      style: input.style,
      actionType: input.actionType,
      recordDate: input.recordDate,
      story: input.story,
      provider: env.aiProvider,
      imageGenerationFailed: image.failed,
      imageGenerationError: image.failed ? image.error : undefined,
      analysisGenerationFailed: analysisFailed,
      analysisGenerationError: analysisFailed
        ? analysisResult.reason instanceof Error
          ? analysisResult.reason.message
          : String(analysisResult.reason)
        : undefined
    });
  } catch (error) {
    console.error("[api/ai/generate-record] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成失败。" },
      { status: 400 }
    );
  }
}
