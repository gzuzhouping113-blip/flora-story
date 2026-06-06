import { prisma } from "@/lib/prisma";
import { deleteStoredImages } from "@/lib/storage";
import { withTransientDatabaseRetry } from "@/lib/auth";

type RateLimitOptions = {
  bucket: string;
  limit: number;
  windowSeconds: number;
  message?: string;
};

export function clientIpFromRequest(request: Request) {
  const forwardedFor = request.headers.get("x-forwarded-for");
  if (forwardedFor) return forwardedFor.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") || "unknown";
}

export async function assertRateLimit(options: RateLimitOptions) {
  const since = new Date(Date.now() - options.windowSeconds * 1000);
  const count = await withTransientDatabaseRetry(() => prisma.rateLimitEvent.count({
    where: {
      bucket: options.bucket,
      createdAt: { gt: since }
    }
  }));

  if (count >= options.limit) {
    throw new Error(options.message || "操作太频繁，请稍后再试。");
  }

  await withTransientDatabaseRetry(() => prisma.rateLimitEvent.create({
    data: { bucket: options.bucket }
  }));

  if (Math.random() < 0.03) {
    await withTransientDatabaseRetry(() => prisma.rateLimitEvent.deleteMany({
      where: {
        createdAt: { lt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
      }
    })).catch(() => {});
  }
}

export async function assertOwnedUpload(userId: string, url: string, allowedKinds: string[] = ["original", "generated"]) {
  const asset = await prisma.uploadAsset.findFirst({
    where: {
      userId,
      url,
      kind: { in: allowedKinds }
    }
  });

  if (!asset) {
    throw new Error("图片不属于当前账号，请重新上传。");
  }

  return asset;
}

export async function markAssetsUsed(userId: string, urls: string[]) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  if (uniqueUrls.length === 0) return;

  await prisma.uploadAsset.updateMany({
    where: {
      userId,
      url: { in: uniqueUrls }
    },
    data: { status: "used" }
  });
}

export async function deleteUnusedUploadAssets(userId: string, urls: string[]) {
  const uniqueUrls = [...new Set(urls.filter(Boolean))];
  if (uniqueUrls.length === 0) return;

  const usedRecords = await prisma.flowerRecord.findMany({
    where: {
      userId,
      OR: [
        { originalImageUrl: { in: uniqueUrls } },
        { generatedImageUrl: { in: uniqueUrls } }
      ]
    },
    select: {
      originalImageUrl: true,
      generatedImageUrl: true
    }
  });

  const stillUsed = new Set<string>();
  usedRecords.forEach(record => {
    stillUsed.add(record.originalImageUrl);
    stillUsed.add(record.generatedImageUrl);
  });

  const orphanUrls = uniqueUrls.filter(url => !stillUsed.has(url));
  if (orphanUrls.length === 0) return;

  await prisma.uploadAsset.deleteMany({
    where: {
      userId,
      url: { in: orphanUrls }
    }
  });
  await deleteStoredImages(orphanUrls);
}
