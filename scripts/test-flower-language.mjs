import { readFile } from "node:fs/promises";

const authoritativeFlowerLanguages = JSON.parse(
  await readFile(new URL("../data/flower-language.json", import.meta.url), "utf8")
);

function normalizeFlowerName(name) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[（(][^（）()]*[）)]/g, "")
    .replace(/[，,、/／].*$/g, "")
    .replace(/[“”"'‘’《》（）()\s，,。.!！?？:：;；、/／-]/g, "");
}

function titleSimilarity(aInput, bInput) {
  const a = Array.from(normalizeFlowerName(aInput));
  const b = Array.from(normalizeFlowerName(bInput));
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

function findMeaning(name) {
  const normalized = normalizeFlowerName(name);
  const candidates = authoritativeFlowerLanguages
    .map(entry => {
      let bestScore = 0;
      const names = [entry.name, ...(entry.aliases || [])];
      for (const candidate of names) {
      const normalizedCandidate = normalizeFlowerName(candidate);
        if (!normalizedCandidate) continue;
        if (normalized === normalizedCandidate) bestScore = Math.max(bestScore, 1000 + normalizedCandidate.length);
        else if (normalized.includes(normalizedCandidate)) bestScore = Math.max(bestScore, 700 + normalizedCandidate.length);
        else if (normalizedCandidate.includes(normalized)) bestScore = Math.max(bestScore, 500 + normalizedCandidate.length);
        else if (titleSimilarity(normalized, normalizedCandidate) >= 0.86) bestScore = Math.max(bestScore, 300 + normalizedCandidate.length);
      }
      return { entry, bestScore };
    })
    .filter(candidate => candidate.bestScore > 0)
    .sort((a, b) => b.bestScore - a.bestScore);
  return candidates[0]?.entry || null;
}

const cases = [
  ["红玫瑰", "红玫瑰", "我爱你"],
  ["白玫瑰", "白玫瑰", "郑重珍藏"],
  ["粉色玫瑰", "粉玫瑰", "轻轻发亮"],
  ["黄色玫瑰", "黄玫瑰", "很真诚"],
  ["蓝色妖姬", "蓝玫瑰", "来到你身边"],
  ["红色郁金香", "红郁金香", "勇敢说出"],
  ["粉康乃馨", "粉康乃馨", "温柔长存"],
  ["曼珠沙华", "彼岸花", "绝望相爱"],
  ["彼岸花", "彼岸花", "永不相见"],
  ["白彼岸花", "白彼岸花", "天堂来信"],
  ["向日葵", "向日葵", "追随阳光"],
  ["满天星", "满天星", "星河里"],
  ["小苍兰", "小苍兰", "清甜香气"],
  ["尤加利叶", "尤加利叶", "轻轻收藏"]
];

const results = cases.map(([input, expectedName, expectedMeaningPart]) => {
  const entry = findMeaning(input);
  return {
    input,
    actualName: entry?.name || "",
    actualMeaning: entry?.meaning || "",
    ok: entry?.name === expectedName && entry.meaning.includes(expectedMeaningPart)
  };
});

const failed = results.filter(result => !result.ok);
console.log(JSON.stringify({
  ok: failed.length === 0,
  total: results.length,
  failed,
  samples: results.slice(0, 6)
}, null, 2));

if (failed.length > 0) {
  process.exitCode = 1;
}
