import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const port = 3100;
const baseUrl = `http://127.0.0.1:${port}`;
let savedRecordId = "";
let uploadedFileUrl = "";
const testEmail = `flora-test-${Date.now()}@example.com`;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
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

function createTinyPngFile() {
  const base64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const buffer = Buffer.from(base64, "base64");
  return new File([buffer], "flower-test.png", { type: "image/png" });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
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
      EMAIL_PROVIDER: "mock",
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

try {
  await waitForServer();

  const page = await fetch(`${baseUrl}/flora_story.html`);
  if (!page.ok) throw new Error(`frontend page failed: ${page.status}`);

  const cookieJar = new Map();
  const requestCode = await readJson(await fetch(`${baseUrl}/api/auth/request-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail })
  }), "request login code");

  const prismaForCode = new PrismaClient();
  const challenge = await prismaForCode.emailLoginChallenge.findFirst({
    where: { email: requestCode.email },
    orderBy: { createdAt: "desc" }
  });
  if (!challenge) throw new Error("login challenge was not created.");
  await prismaForCode.emailLoginChallenge.update({
    where: { id: challenge.id },
    data: { codeHash: sha256("123456") }
  });
  await prismaForCode.$disconnect();

  const loginResponse = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: testEmail, code: "123456" })
  });
  const setCookie = loginResponse.headers.get("set-cookie");
  if (setCookie) cookieJar.set("cookie", setCookie.split(";")[0]);
  const login = await readJson(loginResponse, "verify login code");
  if (!login.user?.email) throw new Error("login did not return user.");

  const authHeaders = cookieJar.get("cookie") ? { Cookie: cookieJar.get("cookie") } : {};

  const formData = new FormData();
  formData.append("file", createTinyPngFile());
  const upload = await readJson(await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    body: formData
  }), "upload");
  uploadedFileUrl = upload.url;

  const generated = await readJson(await fetch(`${baseUrl}/api/ai/generate-record`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
      await prisma.flowerRecord.deleteMany({ where: { id: savedRecordId } });
      await prisma.$disconnect();
    } catch (error) {
      console.error("cleanup failed:", error);
    }
  }
  try {
    const prisma = new PrismaClient();
    await prisma.user.deleteMany({ where: { email: testEmail } });
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
  child.kill();
}
