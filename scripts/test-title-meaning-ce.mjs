import { spawn } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

const port = 3102;
const baseUrl = `http://127.0.0.1:${port}`;
const totalCases = 20;
const email = `ce-title-meaning-${Date.now()}@example.com`;
const password = "ce-test-123456";

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForServer() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const response = await fetch(`${baseUrl}/flora_story.html`);
      if (response.ok) return;
    } catch {}
    await sleep(1000);
  }
  throw new Error("CE test server did not start in time.");
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
  return new File([Buffer.from(base64, "base64")], "flower-ce.png", { type: "image/png" });
}

function normalizeTitle(title) {
  return title.trim().replace(/[“”"'‘’《》（）()\s，,。.!！?？:：;；、/／-]/g, "");
}

function bigrams(value) {
  const chars = Array.from(normalizeTitle(value));
  if (chars.length <= 1) return new Set(chars);
  const grams = new Set();
  for (let i = 0; i < chars.length - 1; i += 1) grams.add(`${chars[i]}${chars[i + 1]}`);
  return grams;
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter(item => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function levenshteinSimilarity(aInput, bInput) {
  const a = Array.from(normalizeTitle(aInput));
  const b = Array.from(normalizeTitle(bInput));
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}

function titleSimilarity(a, b) {
  const normalizedA = normalizeTitle(a);
  const normalizedB = normalizeTitle(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;
  return Math.max(jaccard(bigrams(normalizedA), bigrams(normalizedB)), levenshteinSimilarity(normalizedA, normalizedB));
}

async function stopServer(child) {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    await new Promise(resolve => killer.on("exit", resolve));
    return;
  }
  child.kill("SIGTERM");
}

const nextCli = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    AI_PROVIDER: "mock",
    STORAGE_PROVIDER: "local",
    PUBLIC_APP_URL: baseUrl
  },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await waitForServer();
  const prisma = new PrismaClient();

  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  const cookie = (registerResponse.headers.get("set-cookie") || "").split(";")[0];
  const register = await readJson(registerResponse, "register");
  const userId = register.user.id;

  const historicalTitles = [
    "六月花信",
    "六月花讯",
    "花开此刻",
    "春日信",
    "晚风花"
  ];

  await prisma.flowerRecord.createMany({
    data: historicalTitles.map((title, index) => ({
      userId,
      title,
      comment: "历史标题",
      story: "",
      actionType: "received",
      recordDate: new Date(`2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`),
      style: "original",
      originalImageUrl: `${baseUrl}/uploads/original/history-${index}.png`,
      generatedImageUrl: `${baseUrl}/uploads/original/history-${index}.png`,
      flowers: [{ name: "红玫瑰", meaning: "旧花语" }]
    }))
  });

  await prisma.flowerMeaningMemory.createMany({
    data: [
      {
        userId,
        flowerName: "红玫瑰",
        normalizedName: "红玫瑰",
        meaning: "热烈真心，愿爱长久不褪色"
      },
      {
        userId,
        flowerName: "满天星",
        normalizedName: "满天星",
        meaning: "细碎温柔，把陪伴写成星河"
      },
      {
        userId,
        flowerName: "小苍兰",
        normalizedName: "小苍兰",
        meaning: "清甜温柔，像迟来的晚安"
      },
      {
        userId,
        flowerName: "测试花",
        normalizedName: "测试花",
        meaning: "用户词库里的专属花语"
      }
    ],
    skipDuplicates: true
  });

  const formData = new FormData();
  formData.append("file", createTinyPngFile());
  const upload = await readJson(await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: formData
  }), "upload");

  const results = [];
  for (let i = 0; i < totalCases; i += 1) {
    const generated = await readJson(await fetch(`${baseUrl}/api/ai/generate-record`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        originalImageUrl: upload.url,
        actionType: i % 2 === 0 ? "received" : "sent",
        recordDate: `2026-06-${String((i % 20) + 1).padStart(2, "0")}`,
        story: i % 3 === 0 ? "深夜收到的一束花" : "普通的一天，也被认真记住",
        style: "original"
      })
    }), `generate ${i + 1}`);

    const maxSimilarity = Math.max(...historicalTitles.map(title => titleSimilarity(generated.title, title)));
    const authoritativeMatches = generated.meaningAuthoritativeMatches || 0;
    const validMeanings = (generated.flower_details || []).filter(flower => {
      return flower.name === "红玫瑰"
        ? flower.meaning === "热恋、我爱你"
        : flower.name === "满天星"
          ? flower.meaning === "真心喜欢"
          : flower.name === "小苍兰"
            ? flower.meaning === "纯洁、幸福"
            : flower.name === "尤加利叶"
              ? flower.meaning === "恩赐、回忆"
              : true;
    }).length;
    results.push({
      title: generated.title,
      maxSimilarity,
      matchedCount: generated.meaningMemoryMatchedCount,
      authoritativeMatches,
      validMeanings
    });

    await readJson(await fetch(`${baseUrl}/api/records`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({
        title: generated.title,
        comment: generated.comment,
        story: generated.story || "",
        actionType: generated.actionType,
        recordDate: generated.recordDate,
        style: generated.style,
        originalImageUrl: generated.originalImageUrl,
        generatedImageUrl: generated.generatedImageUrl,
        flower_details: generated.flower_details
      })
    }), `save ${i + 1}`);
  }

  const maxSimilarity = Math.max(...results.map(result => result.maxSimilarity));
  const overThreshold = results.filter(result => result.maxSimilarity >= 0.8).length;
  const memoryMatchedCases = results.filter(result => result.matchedCount >= 1).length;
  const authoritativeCases = results.filter(result => result.authoritativeMatches >= 1).length;
  const validMeaningCases = results.filter(result => result.validMeanings >= 1).length;

  console.log(JSON.stringify({
    ok: overThreshold === 0 && memoryMatchedCases === totalCases && authoritativeCases === totalCases && validMeaningCases === totalCases,
    totalCases,
    maxSimilarity,
    overThreshold,
    memoryMatchedCases,
    authoritativeCases,
    validMeaningCases,
    sampleTitles: results.slice(0, 8).map(result => result.title)
  }, null, 2));

  await prisma.flowerRecord.deleteMany({ where: { userId } });
  await prisma.uploadAsset.deleteMany({ where: { userId } });
  await prisma.flowerMeaningMemory.deleteMany({ where: { userId } });
  await prisma.session.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.rateLimitEvent.deleteMany({
    where: {
      OR: [
        { bucket: { contains: userId } },
        { bucket: { contains: email } },
        { bucket: { contains: "unknown" } }
      ]
    }
  });
  await prisma.$disconnect();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopServer(child);
}
