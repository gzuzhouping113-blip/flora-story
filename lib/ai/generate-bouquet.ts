import { analyzeBouquetWithArk, generateImageWithArk } from "@/lib/ai/ark";
import { mockAnalyzeBouquet, mockGeneratedImage } from "@/lib/ai/mock";
import { analyzeBouquetWithOpenAI, generateImageWithOpenAI } from "@/lib/ai/openai";
import { env } from "@/lib/env";
import {
  applyMeaningMemory,
  chooseDistinctFallbackTitle,
  getMeaningMemory,
  getRecentTitles,
  maxTitleSimilarity
} from "@/lib/flower-memory";
import { prisma } from "@/lib/prisma";
import type { StoredGeneratedImage } from "@/lib/storage";
import type { AiAnalysis, GenerateRecordRequest } from "@/lib/validation";

async function analyzeWithProvider(input: GenerateRecordRequest & { recentTitles?: string[] }) {
  if (env.aiProvider === "ark") return analyzeBouquetWithArk(input);
  if (env.aiProvider === "openai") return analyzeBouquetWithOpenAI(input);
  return mockAnalyzeBouquet(input);
}

async function analyzeWithTitleAudit(input: GenerateRecordRequest, recentTitles: string[]) {
  const analysis = await analyzeWithProvider({
    ...input,
    recentTitles
  });
  const similarity = maxTitleSimilarity(analysis.title, recentTitles);
  if (similarity >= 0.8) {
    const fallbackTitle = chooseDistinctFallbackTitle(recentTitles, analysis.title);
    return {
      analysis: {
        ...analysis,
        title: fallbackTitle
      },
      titleSimilarity: maxTitleSimilarity(fallbackTitle, recentTitles),
      titleRegenerated: true
    };
  }
  return { analysis, titleSimilarity: similarity, titleRegenerated: false };
}

function normalizeGeneratedImageOutput(output: string | StoredGeneratedImage): StoredGeneratedImage {
  return typeof output === "string" ? { url: output } : output;
}

export function imageUrlTail(url: string) {
  return url.replace(/^https?:\/\/[^/]+\//, ".../").slice(-160);
}

export async function generateBouquetForUser(userId: string, input: GenerateRecordRequest) {
  const [recentTitles, meaningMemory] = await Promise.all([
    getRecentTitles(userId),
    getMeaningMemory(userId)
  ]);
  const analysisPromise = analyzeWithTitleAudit(input, recentTitles);

  const imagePromise: Promise<StoredGeneratedImage & { failed: boolean; error: string }> = input.style === "original"
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
      .then(output => ({ ...normalizeGeneratedImageOutput(output), failed: false, error: "" }))
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
    console.error("[ai/generate-bouquet] analysis failed", {
      provider: env.aiProvider,
      style: input.style,
      originalImage: imageUrlTail(input.originalImageUrl),
      error: message
    });
    throw new Error(message);
  }

  const auditedAnalysis = analysisResult.value;
  const meaningResult = applyMeaningMemory(auditedAnalysis.analysis.flower_details, meaningMemory);
  const analysis: AiAnalysis = {
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

  if (image.failed) {
    console.error("[ai/generate-bouquet] image generation failed", {
      provider: env.aiProvider,
      style: input.style,
      originalImage: imageUrlTail(input.originalImageUrl),
      error: image.error
    });
  } else {
    console.info("[ai/generate-bouquet] generation completed", {
      provider: env.aiProvider,
      style: input.style,
      generated: image.url !== input.originalImageUrl
    });
  }

  if (!image.failed && image.url !== input.originalImageUrl) {
    await prisma.uploadAsset.upsert({
      where: { url: image.url },
      update: {
        userId,
        kind: "generated",
        status: "uploaded"
      },
      create: {
        userId,
        url: image.url,
        storageProvider: env.storageProvider,
        kind: "generated",
        status: "uploaded"
      }
    });
  }

  return {
    ...analysis,
    originalImageUrl: input.originalImageUrl,
    generatedImageUrl: image.url,
    generatedPreviewDataUrl: image.previewDataUrl,
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
  };
}
