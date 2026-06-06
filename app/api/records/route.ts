import { NextResponse } from "next/server";
import { getCurrentUser, withTransientDatabaseRetry } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { assertOwnedUpload, markAssetsUsed } from "@/lib/security";
import { saveRecordRequestSchema } from "@/lib/validation";

function toClientRecord(record: {
  id: string;
  title: string;
  comment: string;
  story: string | null;
  actionType: string;
  recordDate: Date;
  style: string;
  originalImageUrl: string;
  generatedImageUrl: string;
  flowers: unknown;
  createdAt: Date;
}) {
  return {
    id: record.id,
    title: record.title,
    comment: record.comment,
    story: record.story || "",
    actionType: record.actionType,
    recordDate: record.recordDate.toISOString(),
    style: record.style,
    originalImageUrl: record.originalImageUrl,
    generatedImageUrl: record.generatedImageUrl,
    flower_details: record.flowers,
    createdAt: record.createdAt.toISOString()
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const year = searchParams.get("year");
  const actionType = searchParams.get("actionType");
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ records: [] });
  }

  const records = await withTransientDatabaseRetry(() => prisma.flowerRecord.findMany({
    where: {
      userId: user.id,
      ...(actionType && actionType !== "all" ? { actionType } : {}),
      ...(year && year !== "all"
        ? {
            recordDate: {
              gte: new Date(`${year}-01-01T00:00:00.000Z`),
              lt: new Date(`${Number(year) + 1}-01-01T00:00:00.000Z`)
            }
          }
        : {})
    },
    orderBy: { recordDate: "desc" }
  }));

  return NextResponse.json({ records: records.map(toClientRecord) });
}

export async function POST(request: Request) {
  try {
    const input = saveRecordRequestSchema.parse(await request.json());
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ error: "请先登录后再保存花束。" }, { status: 401 });
    }
    await assertOwnedUpload(user.id, input.originalImageUrl, ["original"]);
    await assertOwnedUpload(user.id, input.generatedImageUrl, ["original", "generated"]);

    const record = await withTransientDatabaseRetry(() => prisma.flowerRecord.create({
      data: {
        userId: user.id,
        title: input.title,
        comment: input.comment,
        story: input.story || null,
        actionType: input.actionType,
        recordDate: new Date(input.recordDate),
        style: input.style,
        originalImageUrl: input.originalImageUrl,
        generatedImageUrl: input.generatedImageUrl,
        flowers: input.flower_details
      }
    }));
    await markAssetsUsed(user.id, [input.originalImageUrl, input.generatedImageUrl]);

    return NextResponse.json({ record: toClientRecord(record) }, { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "保存失败。" },
      { status: 400 }
    );
  }
}
