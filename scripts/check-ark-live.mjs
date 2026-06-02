import { readFile } from "node:fs/promises";

const envText = await readFile(".env.local", "utf8").catch(() => "");

function readEnv(name, fallback = "") {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const match = envText.match(new RegExp(`^${name}\\s*=\\s*["']?([^"'\\r\\n]*)["']?`, "m"));
  return match?.[1]?.trim() || fallback;
}

const arkApiKey = readEnv("ARK_API_KEY");
const arkBaseUrl = readEnv("ARK_BASE_URL", "https://ark.cn-beijing.volces.com/api/v3").replace(/\/$/, "");
const arkVisionModel = readEnv("ARK_VISION_MODEL");

if (!arkApiKey || !arkVisionModel) {
  console.error("请先在 .env.local 配置 ARK_API_KEY 和 ARK_VISION_MODEL。");
  process.exit(1);
}

const response = await fetch(`${arkBaseUrl}/responses`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${arkApiKey}`,
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    model: arkVisionModel,
    input: [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "请只输出一个合法 JSON：{\"ok\":true}"
          }
        ]
      }
    ],
    text: { format: { type: "json_object" } }
  })
});

const body = await response.text();
if (!response.ok) {
  console.error(JSON.stringify({
    ok: false,
    status: response.status,
    body
  }, null, 2));
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  status: response.status,
  model: arkVisionModel,
  bodyPreview: body.slice(0, 500)
}, null, 2));
