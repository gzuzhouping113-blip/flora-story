import { NextResponse } from "next/server";
import { z } from "zod";
import { loginWithPassword, withTransientDatabaseRetry } from "@/lib/auth";
import { assertRateLimit, clientIpFromRequest } from "@/lib/security";

const loginSchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(72)
});

export async function POST(request: Request) {
  try {
    const input = loginSchema.parse(await request.json());
    const email = input.email.trim().toLowerCase();
    const ip = clientIpFromRequest(request);
    await assertRateLimit({
      bucket: `login:email:${email}`,
      limit: 8,
      windowSeconds: 15 * 60,
      message: "登录尝试太频繁，请稍后再试。"
    });
    await assertRateLimit({
      bucket: `login:ip:${ip}`,
      limit: 40,
      windowSeconds: 15 * 60,
      message: "登录尝试太频繁，请稍后再试。"
    });
    const user = await withTransientDatabaseRetry(() => loginWithPassword(input.email, input.password));
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
