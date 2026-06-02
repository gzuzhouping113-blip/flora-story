import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { deleteStoredImages } from "@/lib/storage";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params;

  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再删除记录。" }, { status: 401 });
    }

    const record = await prisma.flowerRecord.findFirst({
      where: {
        id,
        userId: user.id
      },
      select: {
        originalImageUrl: true,
        generatedImageUrl: true
      }
    });

    if (!record) {
      return NextResponse.json({ error: "记录不存在或无权删除。" }, { status: 404 });
    }

    await prisma.flowerRecord.delete({ where: { id } });

    const imageUrls = [...new Set([record.originalImageUrl, record.generatedImageUrl])];
    const orphanedImageUrls = await Promise.all(imageUrls.map(async url => {
      const stillUsed = await prisma.flowerRecord.count({
        where: {
          OR: [
            { originalImageUrl: url },
            { generatedImageUrl: url }
          ]
        }
      });
      return stillUsed === 0 ? url : null;
    }));

    await deleteStoredImages(orphanedImageUrls);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除失败。" },
      { status: 500 }
    );
  }
}
