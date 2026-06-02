import { cookies } from "next/headers";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { assertEmailReady, env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

const codeTtlMinutes = 10;
const resendCooldownSeconds = 60;
const hourlyCodeLimit = 5;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export function createLoginCode() {
  return String(randomInt(100000, 999999));
}

export async function createEmailChallenge(emailInput: string) {
  const email = normalizeEmail(emailInput);
  const cooldownSince = new Date(Date.now() - resendCooldownSeconds * 1000);
  const recentChallenge = await prisma.emailLoginChallenge.findFirst({
    where: {
      email,
      createdAt: { gt: cooldownSince }
    },
    orderBy: { createdAt: "desc" }
  });
  if (recentChallenge) {
    throw new Error("验证码刚刚发送过，请稍后再试。");
  }

  const hourlySince = new Date(Date.now() - 60 * 60 * 1000);
  const hourlyCount = await prisma.emailLoginChallenge.count({
    where: {
      email,
      createdAt: { gt: hourlySince }
    }
  });
  if (hourlyCount >= hourlyCodeLimit) {
    throw new Error("验证码发送太频繁，请一小时后再试。");
  }

  const code = createLoginCode();
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email }
  });

  const challenge = await prisma.emailLoginChallenge.create({
    data: {
      email,
      codeHash: sha256(code),
      expiresAt: new Date(Date.now() + codeTtlMinutes * 60 * 1000),
      userId: user.id
    }
  });

  try {
    await sendLoginCode(email, code);
  } catch (error) {
    await prisma.emailLoginChallenge.delete({ where: { id: challenge.id } }).catch(() => {});
    throw error;
  }
  return { email, expiresInMinutes: codeTtlMinutes };
}

export async function sendLoginCode(email: string, code: string) {
  if (env.emailProvider !== "resend") {
    if (process.env.NODE_ENV === "production") {
      throw new Error("生产环境必须配置真实邮件服务：EMAIL_PROVIDER=resend。");
    }
    console.log(`[Flora Story] ${email} 验证码：${code}`);
    return;
  }

  assertEmailReady();
  const text = [
    `你的 Flora Story 验证码是 ${code}。`,
    "",
    `${codeTtlMinutes} 分钟内有效。若不是你本人操作，可以忽略这封邮件。`
  ].join("\n");

  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#202124;padding:24px;">
      <p style="margin:0 0 12px;">你好，</p>
      <p style="margin:0 0 16px;">这是你的 Flora Story 登录验证码：</p>
      <div style="font-size:32px;font-weight:700;letter-spacing:8px;color:#111827;margin:24px 0;">${code}</div>
      <p style="margin:0;color:#6b7280;">验证码 ${codeTtlMinutes} 分钟内有效。若不是你本人操作，可以忽略这封邮件。</p>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.resendApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "flora-story/0.1.0"
    },
    body: JSON.stringify({
      from: env.mailFrom,
      to: email,
      subject: "Flora Story 登录验证码",
      text,
      html
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`邮件发送失败：${response.status} ${text}`);
  }
}

export async function verifyEmailCode(emailInput: string, code: string) {
  const email = normalizeEmail(emailInput);
  const challenge = await prisma.emailLoginChallenge.findFirst({
    where: {
      email,
      codeHash: sha256(code.trim()),
      consumedAt: null,
      expiresAt: { gt: new Date() }
    },
    orderBy: { createdAt: "desc" }
  });

  if (!challenge) {
    throw new Error("验证码无效或已过期。");
  }

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email }
  });

  await prisma.emailLoginChallenge.update({
    where: { id: challenge.id },
    data: { consumedAt: new Date(), userId: user.id }
  });

  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + env.sessionDays * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt
    }
  });

  const cookieStore = await cookies();
  cookieStore.set(env.authCookieName, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt
  });

  return user;
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(env.authCookieName)?.value;
  if (!token) return null;

  const session = await prisma.session.findFirst({
    where: {
      tokenHash: sha256(token),
      expiresAt: { gt: new Date() }
    },
    include: { user: true }
  });

  return session?.user || null;
}

export async function clearCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(env.authCookieName)?.value;
  if (token) {
    await prisma.session.deleteMany({
      where: { tokenHash: sha256(token) }
    });
  }
  cookieStore.delete(env.authCookieName);
}
