import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { analyzeBouquetWithArk, generateImageWithArk } from "@/lib/ai/ark";
import { mockAnalyzeBouquet, mockGeneratedImage } from "@/lib/ai/mock";
import { generateRecordRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 120;

export async function POST(request: Request) {
  try {
    const input = generateRecordRequestSchema.parse(await request.json());
    const analysis = env.aiProvider === "ark"
      ? await analyzeBouquetWithArk(input)
      : mockAnalyzeBouquet(input);

    const generatedImageUrl = input.style === "original"
      ? input.originalImageUrl
      : env.aiProvider === "ark"
        ? await generateImageWithArk({
            originalImageUrl: input.originalImageUrl,
            style: input.style
          })
        : mockGeneratedImage(input.originalImageUrl);

    return NextResponse.json({
      ...analysis,
      originalImageUrl: input.originalImageUrl,
      generatedImageUrl,
      style: input.style,
      actionType: input.actionType,
      recordDate: input.recordDate,
      story: input.story,
      provider: env.aiProvider
    });
  } catch (error) {
    console.error("[api/ai/generate-record] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成失败。" },
      { status: 400 }
    );
  }
}
