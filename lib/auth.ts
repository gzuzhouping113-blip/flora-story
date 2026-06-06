import { cookies } from "next/headers";
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";

const scrypt = promisify(scryptCallback);
const passwordKeyLength = 64;
const transientDatabaseRetryDelayMs = 700;

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function validatePassword(password: string) {
  if (password.length < 6) {
    throw new Error("密码至少需要 6 位。");
  }
  if (password.length > 72) {
    throw new Error("密码不能超过 72 位。");
  }
}

function isTransientDatabaseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /P1001|P1002|Can't reach database server|Timed out fetching a new connection|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection terminated/i
    .test(message);
}

export async function withTransientDatabaseRetry<T>(fn: () => Promise<T>) {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (!isTransientDatabaseError(error) || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, transientDatabaseRetryDelayMs * (attempt + 1)));
    }
  }

  if (isTransientDatabaseError(lastError)) {
    throw new Error("数据库连接暂时不稳定，请稍后再试。");
  }

  throw lastError;
}

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, passwordKeyLength) as Buffer;
  return `scrypt:${salt}:${derivedKey.toString("hex")}`;
}

async function verifyPassword(password: string, passwordHash: string) {
  const [algorithm, salt, storedHash] = passwordHash.split(":");
  if (algorithm !== "scrypt" || !salt || !storedHash) return false;

  const derivedKey = await scrypt(password, salt, passwordKeyLength) as Buffer;
  const storedBuffer = Buffer.from(storedHash, "hex");
  return storedBuffer.length === derivedKey.length && timingSafeEqual(storedBuffer, derivedKey);
}

async function createSession(userId: string) {
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + env.sessionDays * 24 * 60 * 60 * 1000);
  await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      userId,
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
}

export async function registerWithPassword(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  validatePassword(password);

  const passwordHash = await hashPassword(password);
  const existingUser = await prisma.user.findUnique({ where: { email } });

  if (existingUser?.passwordHash) {
    throw new Error("这个邮箱已经注册过，请直接登录。");
  }

  const user = existingUser
    ? await prisma.user.update({
        where: { id: existingUser.id },
        data: { passwordHash }
      })
    : await prisma.user.create({
        data: { email, passwordHash }
      });

  await createSession(user.id);
  return user;
}

export async function loginWithPassword(emailInput: string, password: string) {
  const email = normalizeEmail(emailInput);
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.passwordHash) {
    throw new Error("这个邮箱还没有注册，请先注册。");
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    throw new Error("邮箱或密码不正确。");
  }

  await createSession(user.id);
  return user;
}

export async function getCurrentUser() {
  const cookieStore = await cookies();
  const token = cookieStore.get(env.authCookieName)?.value;
  if (!token) return null;

  const session = await withTransientDatabaseRetry(() => prisma.session.findFirst({
    where: {
      tokenHash: sha256(token),
      expiresAt: { gt: new Date() }
    },
    include: { user: true }
  }));

  return session?.user || null;
}

export async function clearCurrentSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get(env.authCookieName)?.value;
  if (token) {
    await withTransientDatabaseRetry(() => prisma.session.deleteMany({
      where: { tokenHash: sha256(token) }
    }));
  }
  cookieStore.delete(env.authCookieName);
}
