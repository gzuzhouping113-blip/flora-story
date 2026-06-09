import { z } from "zod";

export const styleSchema = z.enum(["magnet", "watercolor", "polaroid", "original"]);
export const actionTypeSchema = z.enum(["received", "sent", "self"]);

export function cleanFlowerName(name: string) {
  return String(name || "花材")
    .replace(/[（(][^（）()]*[）)]/g, "")
    .replace(/[，,、/／].*$/g, "")
    .trim() || "花材";
}

export const flowerDetailSchema = z.object({
  name: z.string().trim().min(1).max(24).transform(cleanFlowerName),
  meaning: z.string().trim().min(1).max(40)
});

export const aiAnalysisSchema = z.object({
  flower_details: z.array(flowerDetailSchema).min(1).max(5),
  comment: z.string().trim().min(1).max(40),
  title: z.string().trim().min(1).max(12)
});

export const generateRecordRequestSchema = z.object({
  originalImageUrl: z.string().trim().min(1),
  actionType: actionTypeSchema,
  recordDate: z.string().trim().min(8),
  story: z.string().trim().max(300).optional().default(""),
  style: styleSchema
});

export const startGenerationRequestSchema = generateRecordRequestSchema;

export const saveRecordRequestSchema = z.object({
  title: z.string().trim().min(1).max(24),
  comment: z.string().trim().min(1).max(80),
  story: z.string().trim().max(300).optional().default(""),
  actionType: actionTypeSchema,
  recordDate: z.string().trim().min(8),
  style: styleSchema,
  originalImageUrl: z.string().trim().min(1),
  generatedImageUrl: z.string().trim().min(1),
  flower_details: z.array(flowerDetailSchema).min(1).max(5)
});

export const updateRecordRequestSchema = z.object({
  title: z.string().trim().min(1).max(24).optional(),
  comment: z.string().trim().min(1).max(80).optional(),
  story: z.string().trim().max(300).optional(),
  flower_details: z.array(flowerDetailSchema).min(1).max(5).optional()
});

export const regenerateRecordRequestSchema = z.object({
  style: styleSchema.exclude(["original"]).optional()
});

export type Style = z.infer<typeof styleSchema>;
export type ActionType = z.infer<typeof actionTypeSchema>;
export type AiAnalysis = z.infer<typeof aiAnalysisSchema>;
export type GenerateRecordRequest = z.infer<typeof generateRecordRequestSchema>;
export type SaveRecordRequest = z.infer<typeof saveRecordRequestSchema>;
export type UpdateRecordRequest = z.infer<typeof updateRecordRequestSchema>;
