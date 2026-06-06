import { prisma } from "@/lib/prisma";
import { cleanFlowerName, type AiAnalysis } from "@/lib/validation";

type FlowerDetail = AiAnalysis["flower_details"][number];

const genericTitleFallbacks = [
  "晨光来信",
  "晚风有花",
  "心事开了",
  "花在此刻",
  "温柔回声",
  "小春日",
  "风里有你",
  "今日心动",
  "月色花事",
  "花影成诗",
  "一束回音",
  "记得此刻",
  "云边小事",
  "雨后心跳",
  "浅夏回声",
  "落日告白",
  "手心微光",
  "窗边晴信",
  "风停一秒",
  "月下小诗",
  "半日温柔",
  "星河入怀",
  "晴天留白",
  "悄悄发光",
  "软风经过",
  "心动存档",
  "微雨来信",
  "把你记下",
  "花影轻落",
  "小小偏爱",
  "此刻有光",
  "梦里春天",
  "晚霞回信",
  "余温很甜"
];

function normalizeTitle(title: string) {
  return title
    .trim()
    .replace(/[“”"'‘’《》（）()\s，,。.!！?？:：;；、/／-]/g, "");
}

export function normalizeFlowerName(name: string) {
  return cleanFlowerName(name)
    .toLowerCase()
    .replace(/[“”"'‘’《》（）()\s，,。.!！?？:：;；、/／-]/g, "");
}

function bigrams(value: string) {
  const chars = Array.from(normalizeTitle(value));
  if (chars.length <= 1) return new Set(chars);
  const grams = new Set<string>();
  for (let i = 0; i < chars.length - 1; i += 1) {
    grams.add(`${chars[i]}${chars[i + 1]}`);
  }
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>) {
  if (a.size === 0 && b.size === 0) return 1;
  const intersection = [...a].filter(item => b.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function levenshteinSimilarity(aInput: string, bInput: string) {
  const a = Array.from(normalizeTitle(aInput));
  const b = Array.from(normalizeTitle(bInput));
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;

  const dp = Array.from({ length: a.length + 1 }, () => Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i += 1) dp[i][0] = i;
  for (let j = 0; j <= b.length; j += 1) dp[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return 1 - dp[a.length][b.length] / Math.max(a.length, b.length);
}

export function titleSimilarity(a: string, b: string) {
  const normalizedA = normalizeTitle(a);
  const normalizedB = normalizeTitle(b);
  if (!normalizedA || !normalizedB) return 0;
  if (normalizedA === normalizedB) return 1;
  return Math.max(
    jaccard(bigrams(normalizedA), bigrams(normalizedB)),
    levenshteinSimilarity(normalizedA, normalizedB)
  );
}

export function maxTitleSimilarity(title: string, existingTitles: string[]) {
  return existingTitles.reduce((max, existingTitle) => {
    return Math.max(max, titleSimilarity(title, existingTitle));
  }, 0);
}

export function chooseDistinctFallbackTitle(existingTitles: string[], seed = "") {
  const pool = [...genericTitleFallbacks, seed].filter(Boolean);
  let best = pool[0] || "花开此刻";
  let bestScore = Infinity;
  for (const candidate of pool) {
    const score = maxTitleSimilarity(candidate, existingTitles);
    if (score < bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return best.slice(0, 5);
}

function isFuzzyNameMatch(a: string, b: string) {
  const left = normalizeFlowerName(a);
  const right = normalizeFlowerName(b);
  if (!left || !right) return false;
  return left === right || left.includes(right) || right.includes(left) || titleSimilarity(left, right) >= 0.8;
}

export async function getRecentTitles(userId: string, limit = 30) {
  const records = await prisma.flowerRecord.findMany({
    where: { userId },
    select: { title: true },
    orderBy: { createdAt: "desc" },
    take: limit
  });
  return records.map(record => record.title);
}

export async function getMeaningMemory(userId: string) {
  return prisma.flowerMeaningMemory.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" }
  });
}

export function applyMeaningMemory(
  flowers: FlowerDetail[],
  memories: Awaited<ReturnType<typeof getMeaningMemory>>
) {
  let exactMatches = 0;
  let fuzzyMatches = 0;

  const flowerDetails = flowers.map(flower => {
    const normalized = normalizeFlowerName(flower.name);
    const exact = memories.find(memory => memory.normalizedName === normalized);
    const fuzzy = exact ? null : memories.find(memory => isFuzzyNameMatch(flower.name, memory.flowerName));
    const matched = exact || fuzzy;
    if (exact) exactMatches += 1;
    if (fuzzy) fuzzyMatches += 1;
    return matched
      ? {
          name: cleanFlowerName(flower.name),
          meaning: matched.meaning
        }
      : {
          name: cleanFlowerName(flower.name),
          meaning: flower.meaning
        };
  });

  return {
    flower_details: flowerDetails,
    exactMatches,
    fuzzyMatches,
    matchedCount: exactMatches + fuzzyMatches
  };
}

export async function rememberFlowerMeanings(userId: string, flowers: FlowerDetail[]) {
  for (const flower of flowers) {
    const flowerName = cleanFlowerName(flower.name);
    const normalizedName = normalizeFlowerName(flowerName);
    if (!normalizedName || !flower.meaning?.trim()) continue;

    await prisma.flowerMeaningMemory.upsert({
      where: {
        userId_normalizedName: {
          userId,
          normalizedName
        }
      },
      update: {
        flowerName,
        meaning: flower.meaning.trim(),
        sourceCount: { increment: 1 }
      },
      create: {
        userId,
        flowerName,
        normalizedName,
        meaning: flower.meaning.trim()
      }
    });
  }
}
