import flowerLanguageData from "@/data/flower-language.json";

export type FlowerLanguageEntry = {
  name: string;
  meaning: string;
  aliases?: string[];
  sourceUrls?: string[];
};

export const authoritativeFlowerLanguages = flowerLanguageData as FlowerLanguageEntry[];

export function flattenFlowerLanguageNames(entry: FlowerLanguageEntry) {
  return [entry.name, ...(entry.aliases || [])];
}
