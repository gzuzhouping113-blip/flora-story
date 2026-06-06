import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const port = Number(process.env.TEST_PORT || "3200");
const baseUrl = `http://127.0.0.1:${port}`;
const totalRuns = Number(process.env.OPENAI_IMAGE_TEST_RUNS || "20");
const concurrency = Number(process.env.OPENAI_IMAGE_TEST_CONCURRENCY || "3");
const styles = ["watercolor", "magnet", "polaroid"];
const testEmail = `flora-openai-test-${Date.now()}@example.com`;
const uploadedUrls = new Set();
let testUserId = "";

function loadEnvFile(fileName) {
  return readFile(fileName, "utf8")
    .then(text => {
      text.split(/\r?\n/).forEach(line => {
        const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
        if (!match || process.env[match[1]]) return;
        let value = match[2].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        process.env[match[1]] = value;
      });
    })
    .catch(() => {});
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`${name} is required for live GPT image generation tests.`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/flora_story.html`);
      if (response.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("Next.js live test server did not start in time.");
}

async function readJson(response, label) {
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function createSessionCookie() {
  const prisma = new PrismaClient();
  const user = await prisma.user.upsert({
    where: { email: testEmail },
    update: {},
    create: { email: testEmail }
  });
  testUserId = user.id;

  const token = randomBytes(32).toString("hex");
  await prisma.session.create({
    data: {
      tokenHash: sha256(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  });
  await prisma.$disconnect();
  return `${process.env.AUTH_COOKIE_NAME || "flora_session"}=${token}`;
}

async function pickReferenceImage() {
  const originalDir = path.resolve(process.cwd(), "public", "uploads", "original");
  const candidates = [
    "1780333612969-483f5c5f-c606-489b-b780-cd63813e8e57.jpg",
    "1780333539501-b12abe63-f053-4820-af2f-7b22f735383b.jpg",
    "1780326301265-54ce210f-b9d9-4da5-a191-e7f2662651cf.jpg"
  ];

  for (const name of candidates) {
    const filePath = path.join(originalDir, name);
    try {
      const buffer = await readFile(filePath);
      if (buffer.length > 100_000) {
        return new File([buffer], name, { type: name.endsWith(".png") ? "image/png" : "image/jpeg" });
      }
    } catch {}
  }

  throw new Error("No suitable local bouquet image found in public/uploads/original.");
}

async function uploadReferenceImage(cookie) {
  const file = await pickReferenceImage();
  const formData = new FormData();
  formData.append("file", file);
  const data = await readJson(await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: formData
  }), "upload reference image");
  uploadedUrls.add(data.url);
  uploadedUrls.add(data.publicUrl);
  return data.publicUrl || data.url;
}

async function cleanup() {
  const prisma = new PrismaClient();
  try {
    if (testUserId) {
      const records = await prisma.flowerRecord.findMany({
        where: { userId: testUserId },
        select: { originalImageUrl: true, generatedImageUrl: true }
      });
      records.forEach(record => {
        uploadedUrls.add(record.originalImageUrl);
        uploadedUrls.add(record.generatedImageUrl);
      });
      await prisma.user.deleteMany({ where: { id: testUserId } });
    }
  } finally {
    await prisma.$disconnect();
  }

  const publicDir = path.resolve(process.cwd(), "public");
  for (const url of uploadedUrls) {
    if (!url || !url.startsWith("/uploads/")) continue;
    const filePath = path.resolve(publicDir, url.replace(/^\/+/, ""));
    if (filePath.startsWith(`${publicDir}${path.sep}`)) {
      await rm(filePath, { force: true }).catch(() => {});
    }
  }

  if (process.env.STORAGE_PROVIDER === "cloudinary") {
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;
    if (!cloudName || !apiKey || !apiSecret) return;

    const { v2: cloudinary } = await import("cloudinary");
    cloudinary.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true
    });

    const publicIds = [...uploadedUrls].map(url => {
      try {
        const parsed = new URL(url);
        if (parsed.hostname !== "res.cloudinary.com") return null;
        const parts = parsed.pathname.split("/").filter(Boolean);
        const uploadIndex = parts.indexOf("upload");
        if (parts[0] !== cloudName || parts[1] !== "image" || uploadIndex < 0) return null;
        const publicIdParts = parts.slice(uploadIndex + 1).filter(part => !/^v\d+$/.test(part));
        if (publicIdParts.length === 0) return null;
        publicIdParts[publicIdParts.length - 1] = publicIdParts.at(-1).replace(/\.[^.]+$/, "");
        const publicId = publicIdParts.join("/");
        return publicId.startsWith("flora-story/") ? publicId : null;
      } catch {
        return null;
      }
    }).filter(Boolean);

    await Promise.allSettled([...new Set(publicIds)].map(publicId =>
      cloudinary.uploader.destroy(publicId, { resource_type: "image" })
    ));
  }
}

await loadEnvFile(".env");
await loadEnvFile(".env.local");

requireEnv("OPENAI_BASE_URL");
requireEnv("OPENAI_IMAGE_API_KEY");
requireEnv("OPENAI_VISION_API_KEY");

const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(
  process.execPath,
  [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
  {
    cwd: process.cwd(),
    env: {
      ...process.env,
      AI_PROVIDER: "openai",
      PUBLIC_APP_URL: baseUrl,
      OPENAI_IMAGE_MODEL: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2",
      OPENAI_VISION_MODEL: process.env.OPENAI_VISION_MODEL || "mimo-v2-omni"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);

let serverOutput = "";
child.stdout.on("data", chunk => { serverOutput += chunk.toString(); });
child.stderr.on("data", chunk => { serverOutput += chunk.toString(); });

try {
  await waitForServer();
  const cookie = await createSessionCookie();
  const originalImageUrl = await uploadReferenceImage(cookie);
  const results = [];

  async function runGeneration(index) {
    const style = styles[index % styles.length];
    const startedAt = Date.now();
    try {
      const data = await readJson(await fetch(`${baseUrl}/api/ai/generate-record`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookie
        },
        body: JSON.stringify({
          originalImageUrl,
          actionType: index % 2 === 0 ? "received" : "sent",
          recordDate: "2026-06-04",
          story: "用于上线前稳定性测试的一束花",
          style
        })
      }), `generate ${index + 1}`);

      uploadedUrls.add(data.generatedImageUrl);
      const result = {
        index: index + 1,
        style,
        ok: true,
        analysisOk: !data.analysisGenerationFailed,
        imageOk: !data.imageGenerationFailed && data.generatedImageUrl && data.generatedImageUrl !== data.originalImageUrl,
        fallback: Boolean(data.imageGenerationFailed),
        analysisFallback: Boolean(data.analysisGenerationFailed),
        elapsedMs: Date.now() - startedAt,
        title: data.title,
        flowers: Array.isArray(data.flower_details) ? data.flower_details.length : 0
      };
      results.push(result);
      console.log(`[${index + 1}/${totalRuns}] ${style} ok image=${result.imageOk} elapsed=${result.elapsedMs}ms`);
    } catch (error) {
      const result = {
        index: index + 1,
        style,
        ok: false,
        analysisOk: false,
        imageOk: false,
        fallback: false,
        analysisFallback: false,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      };
      results.push(result);
      console.log(`[${index + 1}/${totalRuns}] ${style} failed elapsed=${result.elapsedMs}ms`);
    }
  }

  let nextIndex = 0;
  async function worker() {
    while (nextIndex < totalRuns) {
      const current = nextIndex;
      nextIndex += 1;
      await runGeneration(current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, totalRuns) }, worker));
  results.sort((a, b) => a.index - b.index);

  const okCount = results.filter(item => item.ok).length;
  const analysisOkCount = results.filter(item => item.analysisOk).length;
  const imageOkCount = results.filter(item => item.imageOk).length;
  const fallbackCount = results.filter(item => item.fallback).length;
  const analysisFallbackCount = results.filter(item => item.analysisFallback).length;
  const elapsed = results.map(item => item.elapsedMs).sort((a, b) => a - b);
  const averageMs = Math.round(results.reduce((sum, item) => sum + item.elapsedMs, 0) / Math.max(results.length, 1));
  const p50Ms = elapsed[Math.floor(elapsed.length * 0.5)] || 0;
  const p90Ms = elapsed[Math.floor(elapsed.length * 0.9)] || 0;

  console.log(JSON.stringify({
    ok: okCount === totalRuns,
    totalRuns,
    requestSuccess: okCount,
    analysisSuccess: analysisOkCount,
    analysisFallback: analysisFallbackCount,
    imageSuccess: imageOkCount,
    fallbackToOriginal: fallbackCount,
    imageSuccessRate: `${Math.round((imageOkCount / totalRuns) * 100)}%`,
    averageMs,
    p50Ms,
    p90Ms,
    results
  }, null, 2));
} catch (error) {
  console.error(serverOutput);
  console.error(error);
  process.exitCode = 1;
} finally {
  child.kill();
  await cleanup().catch(error => {
    console.error("cleanup failed:", error);
  });
}
