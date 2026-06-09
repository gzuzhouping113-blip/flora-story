export function toClientRecord(record: {
  id: string;
  title: string;
  comment: string;
  story: string | null;
  actionType: string;
  recordDate: Date;
  style: string;
  originalImageUrl: string;
  generatedImageUrl: string;
  flowers: unknown;
  generationStatus?: string | null;
  generationError?: string | null;
  createdAt: Date;
  updatedAt?: Date;
}) {
  return {
    id: record.id,
    title: record.title,
    comment: record.comment,
    story: record.story || "",
    actionType: record.actionType,
    recordDate: record.recordDate.toISOString(),
    style: record.style,
    originalImageUrl: record.originalImageUrl,
    generatedImageUrl: record.generatedImageUrl,
    flower_details: record.flowers,
    generationStatus: record.generationStatus || "ready",
    generationError: record.generationError || "",
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt?.toISOString()
  };
}
