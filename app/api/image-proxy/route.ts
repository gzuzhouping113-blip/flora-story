import { NextResponse } from "next/server";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 30;

function isLocalUpload(url: URL) {
  const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
  return process.env.NODE_ENV !== "production"
    && localHosts.has(url.hostname)
    && url.pathname.startsWith("/uploads/");
}

function isOwnUpload(url: URL) {
  if (!env.publicAppUrl) return false;

  try {
    const appUrl = new URL(env.publicAppUrl);
    return url.origin === appUrl.origin && url.pathname.startsWith("/uploads/");
  } catch {
    return false;
  }
}

function isCloudinaryImage(url: URL) {
  if (url.hostname !== "res.cloudinary.com") return false;

  const parts = url.pathname.split("/").filter(Boolean);
  const uploadIndex = parts.indexOf("upload");
  if (parts[1] !== "image" || uploadIndex < 0) return false;
  if (env.cloudinaryCloudName && parts[0] !== env.cloudinaryCloudName) return false;

  const publicIdParts = parts
    .slice(uploadIndex + 1)
    .filter(part => !/^v\d+$/.test(part));
  return publicIdParts.join("/").startsWith("flora-story/");
}

function isR2Image(url: URL) {
  if (!env.r2PublicBaseUrl) return false;

  try {
    const r2BaseUrl = new URL(env.r2PublicBaseUrl);
    return url.origin === r2BaseUrl.origin && url.pathname.startsWith(`${r2BaseUrl.pathname.replace(/\/$/, "")}/uploads/`);
  } catch {
    return false;
  }
}

function isAllowedImageUrl(url: URL) {
  if (!["http:", "https:"].includes(url.protocol)) return false;
  return isCloudinaryImage(url) || isR2Image(url) || isOwnUpload(url) || isLocalUpload(url);
}

export async function GET(request: Request) {
  const rawUrl = new URL(request.url).searchParams.get("url");
  if (!rawUrl) {
    return NextResponse.json({ error: "Missing image url." }, { status: 400 });
  }

  let imageUrl: URL;
  try {
    imageUrl = new URL(rawUrl);
  } catch {
    return NextResponse.json({ error: "Invalid image url." }, { status: 400 });
  }

  if (!isAllowedImageUrl(imageUrl)) {
    return NextResponse.json({ error: "Image url is not allowed." }, { status: 403 });
  }

  try {
    const upstream = await fetch(imageUrl, {
      headers: { "User-Agent": "flora-story/0.1.0" },
      cache: "no-store"
    });

    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ error: `Image fetch failed: ${upstream.status}` }, { status: 502 });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return NextResponse.json({ error: "Remote url is not an image." }, { status: 415 });
    }

    return new Response(upstream.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800"
      }
    });
  } catch (error) {
    console.error("[api/image-proxy] failed", error);
    return NextResponse.json({ error: "Image proxy failed." }, { status: 502 });
  }
}
