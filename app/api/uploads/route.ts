import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertRateLimit, clientIpFromRequest } from "@/lib/security";
import { saveUploadedImage } from "@/lib/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再上传花束照片。" }, { status: 401 });
    }
    const ip = clientIpFromRequest(request);
    await assertRateLimit({
      bucket: `upload:user:${user.id}`,
      limit: 30,
      windowSeconds: 60 * 60,
      message: "上传太频繁了，稍后再试。"
    });
    await assertRateLimit({
      bucket: `upload:ip:${ip}`,
      limit: 80,
      windowSeconds: 60 * 60,
      message: "上传太频繁了，稍后再试。"
    });

    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少图片文件。" }, { status: 400 });
    }

    const saved = await saveUploadedImage(file);
    const assetUrl = saved.publicUrl || saved.url;
    await prisma.uploadAsset.create({
      data: {
        userId: user.id,
        url: assetUrl,
        storageProvider: saved.storageProvider,
        storageKey: saved.key,
        kind: "original"
      }
    });
    return NextResponse.json({ ...saved, url: assetUrl, publicUrl: assetUrl });
  } catch (error) {
    console.error("[api/uploads] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "上传失败。" },
      { status: 400 }
    );
  }
}
