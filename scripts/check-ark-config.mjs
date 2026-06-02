import { readFile } from "node:fs/promises";

const envText = await readFile(".env.local", "utf8").catch(() => "");

function readEnv(name, fallback = "") {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const match = envText.match(new RegExp(`^${name}\\s*=\\s*["']?([^"'\\r\\n]*)["']?`, "m"));
  return match?.[1]?.trim() || fallback;
}

const config = {
  aiProvider: readEnv("AI_PROVIDER", "mock"),
  arkApiKey: readEnv("ARK_API_KEY"),
  arkBaseUrl: readEnv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, ""),
  arkVisionModel: readEnv("ARK_VISION_MODEL"),
  arkImageModel: readEnv("ARK_IMAGE_MODEL"),
  publicAppUrl: readEnv("PUBLIC_APP_URL", "http://127.0.0.1:3000")
};

const missing = [];
if (config.aiProvider !== "ark") missing.push("AI_PROVIDER should be \"ark\" when using Doubao");
if (!config.arkApiKey) missing.push("ARK_API_KEY");
if (!config.arkBaseUrl) missing.push("ARK_BASE_URL");
if (!config.arkVisionModel) missing.push("ARK_VISION_MODEL");
if (!config.arkImageModel) missing.push("ARK_IMAGE_MODEL");

console.log(JSON.stringify({
  ok: missing.length === 0,
  mode: config.aiProvider,
  missing,
  arkBaseUrl: config.arkBaseUrl,
  arkVisionModel: config.arkVisionModel,
  arkImageModel: config.arkImageModel,
  publicAppUrl: config.publicAppUrl,
  apiKey: config.arkApiKey ? "configured" : "missing"
}, null, 2));

if (missing.length > 0) {
  process.exitCode = 1;
}
