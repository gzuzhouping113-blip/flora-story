import { readFile } from "node:fs/promises";

const to = process.argv[2];
if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
  console.error("Usage: npm run check:email:live -- your-email@example.com");
  process.exit(1);
}

const envText = await readFile(".env.local", "utf8").catch(() => "");

function readEnv(name, fallback = "") {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const match = envText.match(new RegExp(`^${name}\\s*=\\s*["']?([^"'\\r\\n]*)["']?`, "m"));
  return match?.[1]?.trim() || fallback;
}

const resendApiKey = readEnv("RESEND_API_KEY");
const mailFrom = readEnv("MAIL_FROM", "Flora Story <onboarding@resend.dev>");

if (!resendApiKey) {
  console.error("RESEND_API_KEY is missing.");
  process.exit(1);
}

const response = await fetch("https://api.resend.com/emails", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${resendApiKey}`,
    "Content-Type": "application/json",
    "User-Agent": "flora-story/0.1.0"
  },
  body: JSON.stringify({
    from: mailFrom,
    to,
    subject: "Flora Story 邮件发送测试",
    text: "如果你收到这封邮件，说明 Flora Story 的 Resend 配置已经可以发送邮件。",
    html: "<p>如果你收到这封邮件，说明 Flora Story 的 Resend 配置已经可以发送邮件。</p>"
  })
});

const payload = await response.json().catch(async () => ({ raw: await response.text() }));
console.log(JSON.stringify({
  ok: response.ok,
  status: response.status,
  from: mailFrom,
  to,
  result: payload
}, null, 2));

if (!response.ok) {
  process.exitCode = 1;
}
