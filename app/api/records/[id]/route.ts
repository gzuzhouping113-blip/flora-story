import { NextResponse } from "next/server";
import { getCurrentUser, withTransientDatabaseRetry } from "@/lib/auth";
import { rememberFlowerMeanings } from "@/lib/flower-memory";
import { prisma } from "@/lib/prisma";
import { toClientRecord } from "@/lib/records";
import { deleteUnusedUploadAssets } from "@/lib/security";
import { updateRecordRequestSchema } from "@/lib/validation";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录。" }, { status: 401 });
    }
    const record = await withTransientDatabaseRetry(() => prisma.flowerRecord.findFirst({
      where: { id, userId: user.id }
    }));
    if (!record) {
      return NextResponse.json({ error: "记录不存在。" }, { status: 404 });
    }
    return NextResponse.json({ record: toClientRecord(record) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "读取失败。" },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request, context: RouteContext) {
  const { id } = await context.params;
  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再编辑记录。" }, { status: 401 });
    }
    const input = updateRecordRequestSchema.parse(await request.json());
    const existing = await withTransientDatabaseRetry(() => prisma.flowerRecord.findFirst({
      where: { id, userId: user.id }
    }));
    if (!existing) {
      return NextResponse.json({ error: "记录不存在或无权编辑。" }, { status: 404 });
    }

    const record = await withTransientDatabaseRetry(() => prisma.flowerRecord.update({
      where: { id },
      data: {
        ...(input.title ? { title: input.title } : {}),
        ...(input.comment ? { comment: input.comment } : {}),
        ...(input.story !== undefined ? { story: input.story || null } : {}),
        ...(input.flower_details ? { flowers: input.flower_details } : {})
      }
    }));
    if (input.flower_details) {
      await rememberFlowerMeanings(user.id, input.flower_details);
    }

    return NextResponse.json({ record: toClientRecord(record) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "编辑失败。" },
      { status: 400 }
    );
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  const { id } = await context.params;

  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再删除记录。" }, { status: 401 });
    }

    const record = await withTransientDatabaseRetry(() => prisma.flowerRecord.findFirst({
      where: {
        id,
        userId: user.id
      },
      select: {
        originalImageUrl: true,
        generatedImageUrl: true
      }
    }));

    if (!record) {
      return NextResponse.json({ error: "记录不存在或无权删除。" }, { status: 404 });
    }

    await withTransientDatabaseRetry(() => prisma.flowerRecord.delete({ where: { id } }));
    await deleteUnusedUploadAssets(user.id, [record.originalImageUrl, record.generatedImageUrl]);

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "删除失败。" },
      { status: 500 }
    );
  }
}
