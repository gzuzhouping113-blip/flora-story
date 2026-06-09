import { after } from "next/server";
import { NextResponse } from "next/server";
import { generateImageWithArk } from "@/lib/ai/ark";
import { generateImageWithOpenAI } from "@/lib/ai/openai";
import { getCurrentUser, withTransientDatabaseRetry } from "@/lib/auth";
import { env } from "@/lib/env";
import { mockGeneratedImage } from "@/lib/ai/mock";
import { prisma } from "@/lib/prisma";
import { toClientRecord } from "@/lib/records";
import { deleteUnusedUploadAssets, markAssetsUsed } from "@/lib/security";
import { regenerateRecordRequestSchema, type Style } from "@/lib/validation";
import type { StoredGeneratedImage } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 120;

type RouteContext = { params: Promise<{ id: string }> };

function normalizeGeneratedImageOutput(output: string | StoredGeneratedImage): StoredGeneratedImage {
  return typeof output === "string" ? { url: output } : output;
}

async function generateImageOnly(input: {
  originalImageUrl: string;
  style: Exclude<Style, "original">;
}) {
  if (env.aiProvider === "ark") return generateImageWithArk(input);
  if (env.aiProvider === "openai") return generateImageWithOpenAI(input);
  return normalizeGeneratedImageOutput(mockGeneratedImage(input.originalImageUrl));
}

async function runRegeneration(userId: string, recordId: string, input: {
  originalImageUrl: string;
  previousGeneratedImageUrl: string;
  style: Exclude<Style, "original">;
}) {
  try {
    const image = normalizeGeneratedImageOutput(await generateImageOnly({
      originalImageUrl: input.originalImageUrl,
      style: input.style
    }));
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
    await withTransientDatabaseRetry(() => prisma.flowerRecord.updateMany({
      where: { id: recordId, userId },
      data: {
        style: input.style,
        generatedImageUrl: image.url,
        generationStatus: "ready",
        generationError: null
      }
    }));
    await markAssetsUsed(userId, [input.originalImageUrl, image.url]);
    await deleteUnusedUploadAssets(userId, [input.previousGeneratedImageUrl]);
  } catch (error) {
    const message = error instanceof Error ? error.message : "重新生成失败。";
    console.error("[api/records/regenerate] failed", { recordId, error: message });
    await withTransientDatabaseRetry(() => prisma.flowerRecord.updateMany({
      where: { id: recordId, userId },
      data: {
        generationStatus: "failed",
        generationError: message
      }
    })).catch(() => {});
  }
}

export async function POST(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再重新生成。" }, { status: 401 });
    }
    const input = regenerateRecordRequestSchema.parse(await request.json());
    const record = await withTransientDatabaseRetry(() => prisma.flowerRecord.findFirst({
      where: { id, userId: user.id }
    }));
    if (!record) {
      return NextResponse.json({ error: "记录不存在或无权重新生成。" }, { status: 404 });
    }

    const style = (input.style || record.style) as Style;
    if (style === "original") {
      return NextResponse.json({ error: "原图风格不需要重新生成。" }, { status: 400 });
    }

    const pending = await withTransientDatabaseRetry(() => prisma.flowerRecord.update({
      where: { id },
      data: {
        style,
        generationStatus: "generating",
        generationError: null
      }
    }));
    after(() => runRegeneration(user.id, id, {
      originalImageUrl: record.originalImageUrl,
      previousGeneratedImageUrl: record.generatedImageUrl,
      style
    }));

    return NextResponse.json({ record: toClientRecord(pending) }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "重新生成失败。" },
      { status: 400 }
    );
  }
}
