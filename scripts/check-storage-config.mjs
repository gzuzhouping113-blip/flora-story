import { readFile } from "node:fs/promises";

const envText = await readFile(".env.local", "utf8").catch(() => "");

function readEnv(name, fallback = "") {
  const fromProcess = process.env[name];
  if (fromProcess) return fromProcess;
  const match = envText.match(new RegExp(`^${name}\\s*=\\s*["']?([^"'\\r\\n]*)["']?`, "m"));
  return match?.[1]?.trim() || fallback;
}

const config = {
  storageProvider: readEnv("STORAGE_PROVIDER", "local"),
  r2AccountId: readEnv("R2_ACCOUNT_ID"),
  r2AccessKeyId: readEnv("R2_ACCESS_KEY_ID"),
  r2SecretAccessKey: readEnv("R2_SECRET_ACCESS_KEY"),
  r2BucketName: readEnv("R2_BUCKET_NAME"),
  r2PublicBaseUrl: readEnv("R2_PUBLIC_BASE_URL").replace(/\/$/, ""),
  cloudinaryCloudName: readEnv("CLOUDINARY_CLOUD_NAME"),
  cloudinaryApiKey: readEnv("CLOUDINARY_API_KEY"),
  cloudinaryApiSecret: readEnv("CLOUDINARY_API_SECRET")
};

const missing = [];
const warnings = [];

if (!["local", "r2", "cloudinary"].includes(config.storageProvider)) {
  missing.push('STORAGE_PROVIDER must be "local", "r2", or "cloudinary"');
}

if (config.storageProvider === "r2") {
  if (!config.r2AccountId) missing.push("R2_ACCOUNT_ID");
  if (!config.r2AccessKeyId) missing.push("R2_ACCESS_KEY_ID");
  if (!config.r2SecretAccessKey) missing.push("R2_SECRET_ACCESS_KEY");
  if (!config.r2BucketName) missing.push("R2_BUCKET_NAME");
  if (!config.r2PublicBaseUrl) missing.push("R2_PUBLIC_BASE_URL");

  if (config.r2PublicBaseUrl && !/^https:\/\//i.test(config.r2PublicBaseUrl)) {
    warnings.push("R2_PUBLIC_BASE_URL should use https.");
  }
  if (/r2\.cloudflarestorage\.com/i.test(config.r2PublicBaseUrl)) {
    warnings.push("R2_PUBLIC_BASE_URL should be the public r2.dev/custom domain, not the private S3 API endpoint.");
  }
}

if (config.storageProvider === "cloudinary") {
  if (!config.cloudinaryCloudName) missing.push("CLOUDINARY_CLOUD_NAME");
  if (!config.cloudinaryApiKey) missing.push("CLOUDINARY_API_KEY");
  if (!config.cloudinaryApiSecret) missing.push("CLOUDINARY_API_SECRET");
}

console.log(JSON.stringify({
  ok: missing.length === 0,
  storageProvider: config.storageProvider,
  missing,
  warnings,
  r2: {
    accountId: config.r2AccountId ? "configured" : "missing",
    accessKeyId: config.r2AccessKeyId ? "configured" : "missing",
    secretAccessKey: config.r2SecretAccessKey ? "configured" : "missing",
    bucketName: config.r2BucketName || "missing",
    publicBaseUrl: config.r2PublicBaseUrl || "missing"
  },
  cloudinary: {
    cloudName: config.cloudinaryCloudName || "missing",
    apiKey: config.cloudinaryApiKey ? "configured" : "missing",
    apiSecret: config.cloudinaryApiSecret ? "configured" : "missing"
  }
}, null, 2));

if (missing.length > 0) {
  process.exitCode = 1;
}
