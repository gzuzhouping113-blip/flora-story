import { NextResponse } from "next/server";
import { z } from "zod";
import { createEmailChallenge } from "@/lib/auth";

const requestCodeSchema = z.object({
  email: z.string().trim().email()
});

export async function POST(request: Request) {
  try {
    const input = requestCodeSchema.parse(await request.json());
    const result = await createEmailChallenge(input.email);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "验证码发送失败。" },
      { status: 400 }
    );
  }
}
