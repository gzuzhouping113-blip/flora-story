import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const port = 3100;
const baseUrl = `http://127.0.0.1:${port}`;
let savedRecordId = "";
let uploadedFileUrl = "";
let otherUserEmail = "";
const testEmail = `flora-test-${Date.now()}@example.com`;
const testPassword = "flora-test-123456";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function withRetry(label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (!/P1001|P1002|Can't reach database server|Timed out fetching a new connection|ECONNRESET|ETIMEDOUT|ENOTFOUND|Connection terminated/i.test(message)) {
        break;
      }
      await sleep(1000 * attempt);
    }
  }
  throw lastError;
}

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/flora_story.html`);
      if (response.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Next.js test server did not start in time.");
}

async function readJson(response, label) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function expectStatus(response, expectedStatus, label) {
  const data = await response.json().catch(() => ({}));
  if (response.status !== expectedStatus) {
    throw new Error(`${label} expected ${expectedStatus}, got ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

function createTinyPngFile() {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const buffer = Buffer.from(base64, "base64");
  return new File([buffer], "flower-test.png", { type: "image/png" });
}

const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(
  process.execPath,
  [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AI_PROVIDER: "mock",
      STORAGE_PROVIDER: "local",
      PUBLIC_APP_URL: baseUrl
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);

let output = "";
child.stdout.on("data", chunk => {
  output += chunk.toString();
});
child.stderr.on("data", chunk => {
  output += chunk.toString();
});

async function stopTestServer() {
  if (!child.pid || child.exitCode !== null) return;

  if (process.platform === "win32") {
    await new Promise(resolve => {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true
      });
      killer.on("exit", resolve);
      killer.on("error", resolve);
    });
    return;
  }

  child.kill("SIGTERM");
}

try {
  await waitForServer();

  const page = await fetch(`${baseUrl}/flora_story.html`);
  if (!page.ok) throw new Error(`frontend page failed: ${page.status}`);

  otherUserEmail = `flora-other-${Date.now()}@example.com`;
  const prismaForIsolation = new PrismaClient();
  const otherUser = await withRetry("create isolation user", () => prismaForIsolation.user.create({
    data: { email: otherUserEmail }
  }));
  await withRetry("create isolation record", () => prismaForIsolation.flowerRecord.create({
    data: {
      userId: otherUser.id,
      title: "Other User Hidden Test",
      comment: "should stay hidden",
      story: "cross user visibility regression guard",
      actionType: "received",
      recordDate: new Date("2026-06-01T00:00:00.000Z"),
      style: "original",
      originalImageUrl: "/uploads/original/legacy-test.jpg",
      generatedImageUrl: "/uploads/original/legacy-test.jpg",
      flowers: [{ name: "Test flower", meaning: "Only for isolation test" }]
    }
  }));
  await prismaForIsolation.$disconnect();

  const unauthRecords = await readJson(await fetch(`${baseUrl}/api/records?year=all&actionType=all`), "list records without login");
  if ((unauthRecords.records || []).length !== 0) {
    throw new Error(`unauthenticated list leaked records: ${JSON.stringify(unauthRecords.records)}`);
  }

  const unauthFloraBook = await readJson(await fetch(`${baseUrl}/api/flora-book`), "flora book without login");
  if ((unauthFloraBook.flowers || []).length !== 0) {
    throw new Error(`unauthenticated flora book leaked flowers: ${JSON.stringify(unauthFloraBook.flowers)}`);
  }

  await expectStatus(await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    body: new FormData()
  }), 401, "upload without login");

  await expectStatus(await fetch(`${baseUrl}/api/ai/generate-record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      originalImageUrl: "/uploads/original/legacy-test.jpg",
      actionType: "received",
      recordDate: "2026-06-01",
      story: "未登录测试",
      style: "watercolor"
    })
  }), 401, "generate without login");

  await expectStatus(await fetch(`${baseUrl}/api/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title: "未登录保存",
      comment: "should fail",
      story: "",
      actionType: "received",
      recordDate: "2026-06-01",
      style: "original",
      originalImageUrl: "/uploads/original/legacy-test.jpg",
      generatedImageUrl: "/uploads/original/legacy-test.jpg",
      flower_details: [{ name: "Test flower", meaning: "Only for isolation test" }]
    })
  }), 401, "save without login");

  const cookieJar = new Map();
  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword })
  });
  let setCookie = registerResponse.headers.get("set-cookie");
  if (setCookie) cookieJar.set("cookie", setCookie.split(";")[0]);
  const register = await readJson(registerResponse, "register");
  if (!register.user?.email) throw new Error("register did not return user.");

  await readJson(await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: cookieJar.get("cookie") ? { Cookie: cookieJar.get("cookie") } : {}
  }), "logout after register");
  cookieJar.clear();

  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, password: testPassword })
  });
  setCookie = loginResponse.headers.get("set-cookie");
  if (setCookie) cookieJar.set("cookie", setCookie.split(";")[0]);
  const login = await readJson(loginResponse, "login with password");
  if (!login.user?.email) throw new Error("login did not return user.");

  const authHeaders = cookieJar.get("cookie") ? { Cookie: cookieJar.get("cookie") } : {};

  const formData = new FormData();
  formData.append("file", createTinyPngFile());
    const upload = await readJson(await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    body: formData,
    headers: authHeaders
  }), "upload");
  uploadedFileUrl = upload.url;

  const generated = await readJson(await fetch(`${baseUrl}/api/ai/generate-record`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      originalImageUrl: upload.url,
      actionType: "received",
      recordDate: "2026-06-01",
      story: "深夜收到的一束花",
      style: "magnet"
    })
  }), "generate");

  if (!generated.title || !generated.comment || !Array.isArray(generated.flower_details)) {
    throw new Error(`generate payload invalid: ${JSON.stringify(generated)}`);
  }

  const saved = await readJson(await fetch(`${baseUrl}/api/records`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders },
    body: JSON.stringify({
      title: generated.title,
      comment: generated.comment,
      story: generated.story,
      actionType: generated.actionType,
      recordDate: generated.recordDate,
      style: generated.style,
      originalImageUrl: generated.originalImageUrl,
      generatedImageUrl: generated.generatedImageUrl,
      flower_details: generated.flower_details
    })
  }), "save record");

  const records = await readJson(await fetch(`${baseUrl}/api/records?year=2026&actionType=all`, {
    headers: authHeaders
  }), "list records");
  if (records.records?.some(record => record.title === "Other User Hidden Test")) {
    throw new Error("logged-in user can see another user's record.");
  }

  const floraBook = await readJson(await fetch(`${baseUrl}/api/flora-book`, {
    headers: authHeaders
  }), "flora book");

  if (!saved.record?.id) throw new Error("saved record did not return id.");
  savedRecordId = saved.record.id;
  if (!records.records?.some(record => record.id === saved.record.id)) {
    throw new Error("saved record not found in list endpoint.");
  }
  if (!Array.isArray(floraBook.flowers)) {
    throw new Error("flora book endpoint did not return flowers array.");
  }

  await readJson(await fetch(`${baseUrl}/api/records/${saved.record.id}`, {
    method: "DELETE",
    headers: authHeaders
  }), "delete record");
  savedRecordId = "";

  const afterDelete = await readJson(await fetch(`${baseUrl}/api/records?year=2026&actionType=all`, {
    headers: authHeaders
  }), "list records after delete");
  if (afterDelete.records?.some(record => record.id === saved.record.id)) {
    throw new Error("deleted record still found in list endpoint.");
  }

  console.log(JSON.stringify({
    ok: true,
    loginEmail: login.user.email,
    uploadUrl: upload.url,
    generatedTitle: generated.title,
    savedRecordId: saved.record.id,
    recordCount: records.records.length,
    floraCount: floraBook.flowers.length,
    unauthIsolation: "ok",
    deleteApi: "ok"
  }, null, 2));
} catch (error) {
  console.error(output);
  console.error(error);
  process.exitCode = 1;
} finally {
  if (savedRecordId) {
    try {
      const prisma = new PrismaClient();
      await withRetry("cleanup saved record", () => prisma.flowerRecord.deleteMany({ where: { id: savedRecordId } }));
      await prisma.$disconnect();
    } catch (error) {
      console.error("cleanup failed:", error);
    }
  }
  try {
    const prisma = new PrismaClient();
    if (otherUserEmail) {
      await withRetry("cleanup isolation user", () => prisma.user.deleteMany({ where: { email: otherUserEmail } }));
    }
    await withRetry("cleanup test user", () => prisma.user.deleteMany({ where: { email: testEmail } }));
    await withRetry("cleanup test rate limits", () => prisma.rateLimitEvent.deleteMany({
      where: {
        OR: [
          { bucket: { contains: "flora-test-" } },
          { bucket: { contains: "flora-other-" } },
          { bucket: { contains: "unknown" } }
        ]
      }
    }));
    await prisma.$disconnect();
  } catch (error) {
    console.error("user cleanup failed:", error);
  }
  if (uploadedFileUrl.startsWith("/uploads/original/")) {
    try {
      const publicDir = path.resolve(process.cwd(), "public");
      const filePath = path.resolve(publicDir, uploadedFileUrl.replace(/^\/+/, ""));
      if (filePath.startsWith(`${publicDir}${path.sep}`)) {
        await rm(filePath, { force: true });
      }
    } catch (error) {
      console.error("upload cleanup failed:", error);
    }
  }
  await stopTestServer();
}
