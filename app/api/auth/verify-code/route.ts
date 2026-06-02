import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyEmailCode } from "@/lib/auth";

const verifyCodeSchema = z.object({
  email: z.string().trim().email(),
  code: z.string().trim().regex(/^\d{6}$/)
});

export async function POST(request: Request) {
  try {
    const input = verifyCodeSchema.parse(await request.json());
    const user = await verifyEmailCode(input.email, input.code);
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "登录失败。" },
      { status: 400 }
    );
  }
}
