import { NextResponse } from "next/server";
import { generateBouquetForUser } from "@/lib/ai/generate-bouquet";
import { getCurrentUser } from "@/lib/auth";
import { assertOwnedUpload, assertRateLimit, clientIpFromRequest } from "@/lib/security";
import { generateRecordRequestSchema } from "@/lib/validation";

export const runtime = "nodejs";
export const maxDuration = 120;

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

    return NextResponse.json(await generateBouquetForUser(user.id, input));
  } catch (error) {
    console.error("[api/ai/generate-record] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "生成失败。" },
      { status: 400 }
    );
  }
}
