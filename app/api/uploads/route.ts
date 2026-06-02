import { NextResponse } from "next/server";
import { saveUploadedImage } from "@/lib/storage";

export async function POST(request: Request) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "缺少图片文件。" }, { status: 400 });
    }

    const saved = await saveUploadedImage(file);
    return NextResponse.json(saved);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "上传失败。" },
      { status: 400 }
    );
  }
}
