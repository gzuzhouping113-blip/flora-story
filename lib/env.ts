export type AiProvider = "mock" | "ark";
export type StorageProvider = "local" | "r2" | "cloudinary";
export type EmailProvider = "mock" | "resend";

function readStorageProvider(): StorageProvider {
  if (process.env.STORAGE_PROVIDER === "r2") return "r2";
  if (process.env.STORAGE_PROVIDER === "cloudinary") return "cloudinary";
  return "local";
}

export const env = {
  aiProvider: (process.env.AI_PROVIDER === "ark" ? "ark" : "mock") as AiProvider,
  storageProvider: readStorageProvider(),
  emailProvider: (process.env.EMAIL_PROVIDER === "resend" ? "resend" : "mock") as EmailProvider,
  arkApiKey: process.env.ARK_API_KEY || "",
  arkBaseUrl: process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3",
  arkImageModel: process.env.ARK_IMAGE_MODEL || "doubao-seedream-5-0-260128",
  arkVisionModel: process.env.ARK_VISION_MODEL || "doubao-seed-2-0-lite-260428",
  publicAppUrl: (process.env.PUBLIC_APP_URL || "http://127.0.0.1:3000").replace(/\/$/, ""),
  r2AccountId: process.env.R2_ACCOUNT_ID || "",
  r2AccessKeyId: process.env.R2_ACCESS_KEY_ID || "",
  r2SecretAccessKey: process.env.R2_SECRET_ACCESS_KEY || "",
  r2BucketName: process.env.R2_BUCKET_NAME || "",
  r2PublicBaseUrl: (process.env.R2_PUBLIC_BASE_URL || "").replace(/\/$/, ""),
  cloudinaryCloudName: process.env.CLOUDINARY_CLOUD_NAME || "",
  cloudinaryApiKey: process.env.CLOUDINARY_API_KEY || "",
  cloudinaryApiSecret: process.env.CLOUDINARY_API_SECRET || "",
  resendApiKey: process.env.RESEND_API_KEY || "",
  mailFrom: process.env.MAIL_FROM || "Flora Story <onboarding@resend.dev>",
  authCookieName: process.env.AUTH_COOKIE_NAME || "flora_session",
  sessionDays: Number(process.env.SESSION_DAYS || "30")
};

export function assertArkReady() {
  if (!env.arkApiKey) {
    throw new Error("ARK_API_KEY is required when AI_PROVIDER=ark.");
  }
}

export function assertR2Ready() {
  const missing = [
    ["R2_ACCOUNT_ID", env.r2AccountId],
    ["R2_ACCESS_KEY_ID", env.r2AccessKeyId],
    ["R2_SECRET_ACCESS_KEY", env.r2SecretAccessKey],
    ["R2_BUCKET_NAME", env.r2BucketName],
    ["R2_PUBLIC_BASE_URL", env.r2PublicBaseUrl]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`R2 storage is not configured. Missing: ${missing.join(", ")}.`);
  }
}

export function assertCloudinaryReady() {
  const missing = [
    ["CLOUDINARY_CLOUD_NAME", env.cloudinaryCloudName],
    ["CLOUDINARY_API_KEY", env.cloudinaryApiKey],
    ["CLOUDINARY_API_SECRET", env.cloudinaryApiSecret]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Cloudinary storage is not configured. Missing: ${missing.join(", ")}.`);
  }
}

export function assertEmailReady() {
  const missing = [
    ["RESEND_API_KEY", env.resendApiKey],
    ["MAIL_FROM", env.mailFrom]
  ].filter(([, value]) => !value).map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Resend email is not configured. Missing: ${missing.join(", ")}.`);
  }

  if (process.env.NODE_ENV === "production" && /@resend\.dev>?$/i.test(env.mailFrom.trim())) {
    throw new Error("Production email must use a sender from your verified domain, not onboarding@resend.dev.");
  }
}
