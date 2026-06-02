import { readFile } from "node:fs/promises";

const envText = await readFile(".env.local", "utf8").catch(() => "");

function readEnv(name, fallback = "") {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const match = envText.match(new RegExp(`^${name}\\s*=\\s*["']?([^"'\\r\\n]*)["']?`, "m"));
  return match?.[1]?.trim() || fallback;
}

const config = {
  emailProvider: readEnv("EMAIL_PROVIDER", "mock"),
  resendApiKey: readEnv("RESEND_API_KEY"),
  mailFrom: readEnv("MAIL_FROM", "Flora Story <onboarding@resend.dev>")
};

const missing = [];
const warnings = [];

if (!["mock", "resend"].includes(config.emailProvider)) {
  missing.push('EMAIL_PROVIDER must be "mock" or "resend"');
}

if (config.emailProvider === "resend") {
  if (!config.resendApiKey) missing.push("RESEND_API_KEY");
  if (!config.mailFrom) missing.push("MAIL_FROM");

  if (/@resend\.dev>?$/i.test(config.mailFrom.trim())) {
    warnings.push("MAIL_FROM is using onboarding@resend.dev. This is only suitable for testing; production needs a sender from your verified domain.");
  }
}

console.log(JSON.stringify({
  ok: missing.length === 0,
  emailProvider: config.emailProvider,
  missing,
  warnings,
  resend: {
    apiKey: config.resendApiKey ? "configured" : "missing",
    mailFrom: config.mailFrom || "missing"
  }
}, null, 2));

if (missing.length > 0) {
  process.exitCode = 1;
}
