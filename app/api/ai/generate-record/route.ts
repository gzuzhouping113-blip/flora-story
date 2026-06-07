import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { analyzeBouquetWithArk, generateImageWithArk } from "@/lib/ai/ark";
import { analyzeBouquetWithOpenAI, generateImageWithOpenAI } from "@/lib/ai/openai";
import { mockAnalyzeBouquet, mockGeneratedImage } from "@/lib/ai/mock";
import { getCurrentUser } from "@/lib/auth";
import {
  applyMeaningMemory,
  chooseDistinctFallbackTitle,
  getMeaningMemory,
  getRecentTitles,
  maxTitleSimilarity
} from "@/lib/flower-memory";
import { prisma } from "@/lib/prisma";
import { assertOwnedUpload, assertRateLimit, clientIpFromRequest } from "@/lib/security";
import { deleteStoredImages } from "@/lib/storage";
import type { AiAnalysis, GenerateRecordRequest } from "@/lib/validation";
import { generateRecordRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 300;

async function analyzeWithProvider(input: GenerateRecordRequest & { recentTitles?: string[] }) {
  if (env.aiProvider === "ark") return analyzeBouquetWithArk(input);
  if (env.aiProvider === "openai") return analyzeBouquetWithOpenAI(input);
  return mockAnalyzeBouquet(input);
}

async function analyzeWithTitleAudit(input: GenerateRecordRequest, recentTitles: string[]) {
  const errors: string[] = [];
  let bestAnalysis: AiAnalysis | null = null;
  let bestSimilarity = Infinity;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const analysis = await analyzeWithProvider({
        ...input,
        recentTitles: attempt === 0
          ? recentTitles
          : [
              ...recentTitles,
              `上一次生成的标题“${bestAnalysis?.title || ""}”相似度过高，请换一种完全不同的意象。`
            ]
      });
      const similarity = maxTitleSimilarity(analysis.title, recentTitles);
      if (similarity < bestSimilarity) {
        bestAnalysis = analysis;
        bestSimilarity = similarity;
      }
      if (similarity < 0.8) {
        return { analysis, titleSimilarity: similarity, titleRegenerated: attempt > 0 };
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  if (bestAnalysis) {
    const fallbackTitle = chooseDistinctFallbackTitle(recentTitles, bestAnalysis.title);
    return {
      analysis: {
        ...bestAnalysis,
        title: fallbackTitle
      },
      titleSimilarity: maxTitleSimilarity(fallbackTitle, recentTitles),
      titleRegenerated: true
    };
  }

  throw new Error(errors.join(" | ") || "标题生成失败。");
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再生成花束。" }, { status: 401 });
    }

    const input = generateRecordRequestSchema.parse(await request.json());
    const ip = clientIpFromRequest(request);
    await assertRateLimit({
      bucket: `ai:user:${user.id}`,
      limit: 20,
      windowSeconds: 24 * 60 * 60,
      message: "今天生成次数有点多了，明天再继续种花吧。"
    });
    await assertRateLimit({
      bucket: `ai:ip:${ip}`,
      limit: 60,
      windowSeconds: 24 * 60 * 60,
      message: "当前网络生成次数较多，请稍后再试。"
    });
    await assertOwnedUpload(user.id, input.originalImageUrl, ["original"]);

    const [recentTitles, meaningMemory] = await Promise.all([
      getRecentTitles(user.id),
      getMeaningMemory(user.id)
    ]);
    const analysisPromise = analyzeWithTitleAudit(input, recentTitles);

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
    if (analysisFailed) {
      const message = analysisResult.reason instanceof Error
        ? analysisResult.reason.message
        : String(analysisResult.reason);
      const generatedImage = imageResult.status === "fulfilled" ? imageResult.value : null;
      if (generatedImage && !generatedImage.failed && generatedImage.url !== input.originalImageUrl) {
        await deleteStoredImages([generatedImage.url]);
      }
      console.error("[api/ai/generate-record] analysis failed", {
        provider: env.aiProvider,
        style: input.style,
        analysisError: message,
        imageError: imageResult.status === "fulfilled" && imageResult.value.failed
          ? imageResult.value.error
          : imageResult.status === "rejected"
            ? imageResult.reason instanceof Error ? imageResult.reason.message : String(imageResult.reason)
            : ""
      });
      return NextResponse.json(
        {
          error: "花朵识别失败，请重试。",
          analysisGenerationFailed: true,
          analysisGenerationError: message,
          imageGenerationFailed: imageResult.status === "fulfilled" ? imageResult.value.failed : true,
          imageGenerationError: imageResult.status === "fulfilled" && imageResult.value.failed
            ? imageResult.value.error
            : imageResult.status === "rejected"
              ? imageResult.reason instanceof Error ? imageResult.reason.message : String(imageResult.reason)
              : undefined,
          originalImageUrl: input.originalImageUrl,
          generatedImageUrl: input.originalImageUrl,
          style: input.style,
          actionType: input.actionType,
          recordDate: input.recordDate,
          story: input.story,
          provider: env.aiProvider
        },
        { status: 502 }
      );
    }

    const auditedAnalysis = analysisResult.value;
    const meaningResult = applyMeaningMemory(auditedAnalysis.analysis.flower_details, meaningMemory);
    const analysis = {
      ...auditedAnalysis.analysis,
      flower_details: meaningResult.flower_details
    };
    const image = imageResult.status === "fulfilled"
      ? imageResult.value
      : {
          url: input.originalImageUrl,
          failed: true,
          error: imageResult.reason instanceof Error ? imageResult.reason.message : String(imageResult.reason)
        };

    if (!image.failed && image.url !== input.originalImageUrl) {
      await prisma.uploadAsset.upsert({
        where: { url: image.url },
        update: {
          userId: user.id,
          kind: "generated",
          status: "uploaded"
        },
        create: {
          userId: user.id,
          url: image.url,
          storageProvider: env.storageProvider,
          kind: "generated",
          status: "uploaded"
        }
      });
    }

    return NextResponse.json({
      ...analysis,
      originalImageUrl: input.originalImageUrl,
      generatedImageUrl: image.url,
      style: input.style,
      actionType: input.actionType,
      recordDate: input.recordDate,
      story: input.story,
      provider: env.aiProvider,
      titleSimilarity: auditedAnalysis.titleSimilarity,
      titleRegenerated: auditedAnalysis.titleRegenerated,
      meaningMemoryMatchedCount: meaningResult.matchedCount,
      meaningAuthoritativeMatches: meaningResult.authoritativeMatches,
      meaningMemoryExactMatches: meaningResult.exactMatches,
      meaningMemoryFuzzyMatches: meaningResult.fuzzyMatches,
      imageGenerationFailed: image.failed,
      imageGenerationError: image.failed ? image.error : undefined,
      analysisGenerationFailed: false
    });
  } catch (error) {
    console.error("[api/ai/generate-record] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成失败。" },
      { status: 400 }
    );
  }
}
