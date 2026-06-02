import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { v2 as cloudinary } from "cloudinary";
import { assertCloudinaryReady, assertR2Ready, env } from "@/lib/env";

const allowedMimeTypes = new Set(["image/jpeg", "image/png", "image/webp"]);

function extensionFromMime(mimeType: string) {
  if (mimeType.includes("png")) return "png";
  if (mimeType.includes("webp")) return "webp";
  return "jpg";
}

function mimeFromExtension(filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function createObjectKey(folder: "original" | "generated", mimeType: string) {
  return `uploads/${folder}/${Date.now()}-${randomUUID()}.${extensionFromMime(mimeType)}`;
}

function publicR2Url(key: string) {
  return `${env.r2PublicBaseUrl}/${key}`;
}

let s3Client: S3Client | null = null;
let cloudinaryConfigured = false;

function getR2Client() {
  assertR2Ready();
  if (!s3Client) {
    s3Client = new S3Client({
      region: "auto",
      endpoint: `https://${env.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: env.r2AccessKeyId,
        secretAccessKey: env.r2SecretAccessKey
      }
    });
  }
  return s3Client;
}

function getCloudinaryClient() {
  assertCloudinaryReady();
  if (!cloudinaryConfigured) {
    cloudinary.config({
      cloud_name: env.cloudinaryCloudName,
      api_key: env.cloudinaryApiKey,
      api_secret: env.cloudinaryApiSecret,
      secure: true
    });
    cloudinaryConfigured = true;
  }
  return cloudinary;
}

function localFilePathFromUrl(url: string) {
  if (!url.startsWith("/uploads/")) return null;

  const relativePath = url.replace(/^\/+/, "");
  const publicDir = path.resolve(process.cwd(), "public");
  const filePath = path.resolve(publicDir, relativePath);
  if (!filePath.startsWith(`${publicDir}${path.sep}`)) {
    throw new Error("图片路径无效。");
  }
  return filePath;
}

function r2KeyFromPublicUrl(url: string) {
  if (!env.r2PublicBaseUrl || !url.startsWith(`${env.r2PublicBaseUrl}/`)) return null;

  const key = url.slice(env.r2PublicBaseUrl.length + 1);
  if (!key.startsWith("uploads/")) return null;
  return key;
}

function cloudinaryPublicIdFromUrl(url: string) {
  if (!env.cloudinaryCloudName) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== "res.cloudinary.com") return null;
  const parts = parsed.pathname.split("/").filter(Boolean);
  const uploadIndex = parts.indexOf("upload");
  if (parts[0] !== env.cloudinaryCloudName || parts[1] !== "image" || uploadIndex < 0) return null;

  const publicIdParts = parts
    .slice(uploadIndex + 1)
    .filter(part => !/^v\d+$/.test(part));
  if (publicIdParts.length === 0) return null;

  const lastPart = publicIdParts.at(-1);
  if (!lastPart) return null;
  publicIdParts[publicIdParts.length - 1] = lastPart.replace(/\.[^.]+$/, "");

  const publicId = publicIdParts.join("/");
  return publicId.startsWith("flora-story/") ? publicId : null;
}

async function uploadBufferToR2(input: {
  folder: "original" | "generated";
  buffer: Buffer;
  mimeType: string;
}) {
  const key = createObjectKey(input.folder, input.mimeType);
  await getR2Client().send(new PutObjectCommand({
    Bucket: env.r2BucketName,
    Key: key,
    Body: input.buffer,
    ContentType: input.mimeType,
    CacheControl: "public, max-age=31536000, immutable"
  }));

  return {
    url: publicR2Url(key),
    publicUrl: publicR2Url(key),
    fileName: path.basename(key),
    key
  };
}

async function uploadBufferToCloudinary(input: {
  folder: "original" | "generated";
  buffer: Buffer;
  mimeType: string;
}) {
  const publicId = `${Date.now()}-${randomUUID()}`;
  const dataUri = `data:${input.mimeType};base64,${input.buffer.toString("base64")}`;
  const result = await getCloudinaryClient().uploader.upload(dataUri, {
    folder: `flora-story/${input.folder}`,
    public_id: publicId,
    resource_type: "image",
    overwrite: false
  });

  return {
    url: result.secure_url,
    publicUrl: result.secure_url,
    fileName: `${publicId}.${extensionFromMime(input.mimeType)}`,
    key: result.public_id
  };
}

async function saveUploadedImageLocal(file: File) {
  const mimeType = file.type;
  const key = createObjectKey("original", mimeType);
  const relativePath = key.replace(/^uploads\//, "uploads/");
  const dir = path.join(process.cwd(), "public", "uploads", "original");
  await mkdir(dir, { recursive: true });
  const buffer = Buffer.from(await file.arrayBuffer());
  const diskPath = path.join(process.cwd(), "public", relativePath);
  await writeFile(diskPath, buffer);

  return {
    url: `/${relativePath.replace(/\\/g, "/")}`,
    publicUrl: `${env.publicAppUrl}/${relativePath.replace(/\\/g, "/")}`,
    fileName: path.basename(key),
    key
  };
}

export async function saveUploadedImage(file: File) {
  if (!allowedMimeTypes.has(file.type)) {
    throw new Error("只支持 JPG、PNG 或 WebP 图片。");
  }

  if (file.size > 8 * 1024 * 1024) {
    throw new Error("图片不能超过 8MB。");
  }

  if (env.storageProvider === "r2") {
    return uploadBufferToR2({
      folder: "original",
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type
    });
  }

  if (env.storageProvider === "cloudinary") {
    return uploadBufferToCloudinary({
      folder: "original",
      buffer: Buffer.from(await file.arrayBuffer()),
      mimeType: file.type
    });
  }

  return saveUploadedImageLocal(file);
}

export async function mirrorRemoteImageToStorage(remoteUrl: string) {
  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new Error(`生成图片下载失败：${response.status}`);
  }

  const mimeType = response.headers.get("content-type") || "image/jpeg";
  const buffer = Buffer.from(await response.arrayBuffer());

  if (env.storageProvider === "r2") {
    const saved = await uploadBufferToR2({
      folder: "generated",
      buffer,
      mimeType
    });
    return saved.url;
  }

  if (env.storageProvider === "cloudinary") {
    const saved = await uploadBufferToCloudinary({
      folder: "generated",
      buffer,
      mimeType
    });
    return saved.url;
  }

  const key = createObjectKey("generated", mimeType);
  const relativePath = key.replace(/^uploads\//, "uploads/");
  const dir = path.join(process.cwd(), "public", "uploads", "generated");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(process.cwd(), "public", relativePath), buffer);
  return `/${relativePath.replace(/\\/g, "/")}`;
}

export async function localImageUrlToDataUrl(url: string) {
  const filePath = localFilePathFromUrl(url);
  if (!filePath) return null;

  const buffer = await readFile(filePath);
  const mimeType = mimeFromExtension(filePath);
  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

export async function deleteStoredImages(urls: Array<string | null | undefined>) {
  const uniqueUrls = [...new Set(urls.filter((url): url is string => Boolean(url)))];

  await Promise.allSettled(uniqueUrls.map(async url => {
    const localPath = localFilePathFromUrl(url);
    if (localPath) {
      await rm(localPath, { force: true });
      return;
    }

    const r2Key = r2KeyFromPublicUrl(url);
    if (r2Key) {
      await getR2Client().send(new DeleteObjectCommand({
        Bucket: env.r2BucketName,
        Key: r2Key
      }));
      return;
    }

    const cloudinaryPublicId = cloudinaryPublicIdFromUrl(url);
    if (cloudinaryPublicId) {
      await getCloudinaryClient().uploader.destroy(cloudinaryPublicId, {
        resource_type: "image"
      });
    }
  }));
}
