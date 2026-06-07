import type { AiAnalysis, GenerateRecordRequest } from "@/lib/validation";

export function mockAnalyzeBouquet(input: Pick<GenerateRecordRequest, "actionType" | "recordDate" | "story">): AiAnalysis {
  const story = input.story?.trim() || "";
  const lateNight = /深夜|想念|晚/.test(story);
  const sent = input.actionType === "sent";
  const self = input.actionType === "self";

  return {
    flower_details: lateNight
      ? [
          { name: "小苍兰", meaning: "清甜温柔，像迟来的晚安" },
          { name: "尤加利叶", meaning: "收藏回忆，也收藏心动" }
        ]
      : [
          {
            name: sent ? "洋桔梗" : self ? "向日葵" : "红玫瑰",
            meaning: sent ? "真诚不变，温柔有回声" : self ? "把明亮认真留给自己" : "热烈坚定，只偏爱你"
          },
          { name: self ? "粉玫瑰" : "满天星", meaning: self ? "把今天过成温柔奖励" : "藏在旁边，也认真发光" }
        ],
    comment: sent ? "这束花很会告白" : self ? "奖励自己很漂亮" : "这束花很会心动",
    title: lateNight ? "晚风花" : sent ? "春日信" : self ? "自留光" : "花开了"
  };
}

export function mockGeneratedImage(originalImageUrl: string) {
  return originalImageUrl;
}
