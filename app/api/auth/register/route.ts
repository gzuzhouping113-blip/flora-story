import { NextResponse } from "next/server";
import { z } from "zod";
import { registerWithPassword, withTransientDatabaseRetry } from "@/lib/auth";
import { assertRateLimit, clientIpFromRequest } from "@/lib/security";

const registerSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(6).max(72)
});

export async function POST(request: Request) {
  try {
    const input = registerSchema.parse(await request.json());
    const email = input.email.trim().toLowerCase();
    const ip = clientIpFromRequest(request);
    await assertRateLimit({
      bucket: `register:email:${email}`,
      limit: 3,
      windowSeconds: 60 * 60,
      message: "注册尝试太频繁，请稍后再试。"
    });
    await assertRateLimit({
      bucket: `register:ip:${ip}`,
      limit: 20,
      windowSeconds: 60 * 60,
      message: "注册尝试太频繁，请稍后再试。"
    });
    const user = await withTransientDatabaseRetry(() => registerWithPassword(input.email, input.password));
    return NextResponse.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName
      }
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "注册失败。" },
      { status: 400 }
    );
  }
}
