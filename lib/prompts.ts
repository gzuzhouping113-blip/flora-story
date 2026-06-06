import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Style } from "@/lib/validation";

const imagePromptFiles: Record<Exclude<Style, "original">, string> = {
  magnet: "magnet.zh.md",
  watercolor: "watercolor.zh.md",
  polaroid: "polaroid.zh.md"
};

function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? "");
}

export async function loadImagePrompt(style: Exclude<Style, "original">) {
  const file = path.join(process.cwd(), "prompts", "image", imagePromptFiles[style]);
  return readFile(file, "utf8");
}

export async function loadVisionPrompt(values: { time: string; story?: string; recentTitles?: string[] }) {
  const file = path.join(process.cwd(), "prompts", "vision", "analyze-bouquet.zh.md");
  const template = await readFile(file, "utf8");
  return renderTemplate(template, {
    time: values.time,
    story: values.story?.trim() || "无",
    recentTitles: values.recentTitles?.length ? values.recentTitles.join("、") : "无"
  });
}
