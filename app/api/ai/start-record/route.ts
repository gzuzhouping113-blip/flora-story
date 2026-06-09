import { after } from "next/server";
import { NextResponse } from "next/server";
import { generateBouquetForUser } from "@/lib/ai/generate-bouquet";
import { getCurrentUser, withTransientDatabaseRetry } from "@/lib/auth";
import { rememberFlowerMeanings } from "@/lib/flower-memory";
import { prisma } from "@/lib/prisma";
import { assertOwnedUpload, assertRateLimit, clientIpFromRequest, markAssetsUsed } from "@/lib/security";
import { startGenerationRequestSchema } from "@/lib/validation";
import { toClientRecord } from "@/lib/records";

export const runtime = "nodejs";
export const maxDuration = 120;

async function runRecordGeneration(userId: string, recordId: string, input: ReturnType<typeof startGenerationRequestSchema.parse>) {
  try {
    const result = await generateBouquetForUser(userId, input);
    const generatedImageUrl = result.imageGenerationFailed
      ? input.originalImageUrl
      : result.generatedImageUrl;
    const status = result.imageGenerationFailed ? "failed" : "ready";
    const generationError = result.imageGenerationFailed
      ? result.imageGenerationError || "图片生成失败，请重新生成。"
      : null;

    await withTransientDatabaseRetry(() => prisma.flowerRecord.updateMany({
      where: { id: recordId, userId },
      data: {
        title: result.title,
        comment: result.comment,
        story: input.story || null,
        actionType: input.actionType,
        recordDate: new Date(input.recordDate),
        style: input.style,
        originalImageUrl: input.originalImageUrl,
        generatedImageUrl,
        flowers: result.flower_details,
        generationStatus: status,
        generationError
      }
    }));
    await markAssetsUsed(userId, [input.originalImageUrl, generatedImageUrl]);
    await rememberFlowerMeanings(userId, result.flower_details);
  } catch (error) {
    const message = error instanceof Error ? error.message : "生成失败，请重新生成。";
    console.error("[api/ai/start-record] background generation failed", {
      recordId,
      error: message
    });
    await withTransientDatabaseRetry(() => prisma.flowerRecord.updateMany({
      where: { id: recordId, userId },
      data: {
        generationStatus: "failed",
        generationError: message
      }
    })).catch(() => {});
  }
}

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再生成花束。" }, { status: 401 });
    }

    const input = startGenerationRequestSchema.parse(await request.json());
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

    const record = await withTransientDatabaseRetry(() => prisma.flowerRecord.create({
      data: {
        userId: user.id,
        title: "图片生成中",
        comment: "图片生成中，请稍后。",
        story: input.story || null,
        actionType: input.actionType,
        recordDate: new Date(input.recordDate),
        style: input.style,
        originalImageUrl: input.originalImageUrl,
        generatedImageUrl: input.originalImageUrl,
        flowers: [],
        generationStatus: "generating",
        generationError: null
      }
    }));
    await markAssetsUsed(user.id, [input.originalImageUrl]);

    after(() => runRecordGeneration(user.id, record.id, input));

    return NextResponse.json({ record: toClientRecord(record) }, { status: 202 });
  } catch (error) {
    console.error("[api/ai/start-record] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成失败。" },
      { status: 400 }
    );
  }
}
