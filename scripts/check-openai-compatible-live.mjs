import fs from "node:fs";

function loadDotEnv(path) {
  if (!fs.existsSync(path)) return;
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key]) continue;
    process.env[key] = rawValue.trim().replace(/^"(.*)"$/, "$1");
  }
}

function baseUrl() {
  const raw = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  return /\/v\d*$/i.test(raw) ? raw : `${raw}/v1`;
}

async function postJson(url, apiKey, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await response.text();
    const elapsedMs = Date.now() - startedAt;
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { ok: response.ok, status: response.status, elapsedMs, data };
  } finally {
    clearTimeout(timer);
  }
}

async function postForm(url, apiKey, formData, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
      signal: controller.signal
    });
    const text = await response.text();
    const elapsedMs = Date.now() - startedAt;
    let data = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text.slice(0, 300) };
    }
    return { ok: response.ok, status: response.status, elapsedMs, data };
  } finally {
    clearTimeout(timer);
  }
}

function summarizeError(data) {
  if (!data || typeof data !== "object") return String(data || "");
  if (data.error) return JSON.stringify(data.error).slice(0, 500);
  if (data.raw) return String(data.raw).slice(0, 500);
  return JSON.stringify(data).slice(0, 500);
}

function summarizePayload(data) {
  if (!data || typeof data !== "object") return String(data || "").slice(0, 500);
  return JSON.stringify({
    keys: Object.keys(data),
    sample: data.raw
      ? String(data.raw).slice(0, 300)
      : JSON.stringify(data).slice(0, 300)
  }, null, 2);
}

function extractText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.slice(0, 120);
  if (Array.isArray(content)) {
    return content.map(item => item.text || item.content || "").join("").slice(0, 120);
  }
  return data?.output_text?.slice?.(0, 120) || "";
}

function hasImage(data) {
  const first = data?.data?.[0] || data?.images?.[0] || data;
  return Boolean(first?.url || first?.b64_json || data?.image);
}

async function checkVision() {
  const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
  const result = await postJson(`${baseUrl()}/chat/completions`, process.env.OPENAI_VISION_API_KEY, {
    model: process.env.OPENAI_VISION_MODEL,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "请看这张测试图。只回复 JSON：{\"ok\":true}" },
        { type: "image_url", image_url: { url: imageDataUrl, detail: "low" } }
      ]
    }],
    stream: false,
    temperature: 0,
    max_tokens: 80
  }, 60_000);

  const text = extractText(result.data);
  if (!result.ok || !text.trim()) {
    return { name: "vision", ok: false, status: result.status, elapsedMs: result.elapsedMs, error: summarizeError(result.data) };
  }
  return { name: "vision", ok: true, status: result.status, elapsedMs: result.elapsedMs, text };
}

async function checkImage() {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAATElEQVR4nO3PQQ3AIADAQMAfKuEeDYKjexjykzMx9LbOrwG+O4A2gDaANoA2gDaANoA2gDaANoA2gDaANoA2gDaANoA2gDaANoA2gLYD0cABV+8J+HcAAAAASUVORK5CYII=", "base64");
  const form = new FormData();
  form.append("model", process.env.OPENAI_IMAGE_MODEL);
  form.append("prompt", "把这张测试色块改成一朵极简水彩小花，纯白背景，竖版。");
  form.append("image", new File([png], "test-flower.png", { type: "image/png" }));
  form.append("n", "1");
  form.append("size", "1024x1536");

  const result = await postForm(`${baseUrl()}/images/edits`, process.env.OPENAI_IMAGE_API_KEY, form, 180_000);
  if (!result.ok) {
    return { name: "image", ok: false, status: result.status, elapsedMs: result.elapsedMs, error: summarizeError(result.data) };
  }
  const ok = hasImage(result.data);
  return { name: "image", ok, status: result.status, elapsedMs: result.elapsedMs, ...(!ok ? { error: summarizePayload(result.data) } : {}) };
}

loadDotEnv(".env.local");

const missing = [
  "OPENAI_BASE_URL",
  "OPENAI_IMAGE_API_KEY",
  "OPENAI_VISION_API_KEY",
  "OPENAI_IMAGE_MODEL",
  "OPENAI_VISION_MODEL"
].filter(name => !process.env[name]);

if (missing.length) {
  console.error(JSON.stringify({ ok: false, missing }, null, 2));
  process.exit(1);
}

const results = [];
results.push(await checkVision());
results.push(await checkImage());

console.log(JSON.stringify({
  ok: results.every(item => item.ok),
  baseUrl: baseUrl(),
  imageModel: process.env.OPENAI_IMAGE_MODEL,
  visionModel: process.env.OPENAI_VISION_MODEL,
  results
}, null, 2));

if (!results.every(item => item.ok)) process.exit(1);
