import type { AiAnalysis, GenerateRecordRequest } from "@/lib/validation";

export function mockAnalyzeBouquet(input: Pick<GenerateRecordRequest, "actionType" | "recordDate" | "story">): AiAnalysis {
  const story = input.story?.trim();
  const lateNight = /夜|晚|想念|深夜/.test(story || "");
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
            name: sent ? "洋桔梗" : (self ? "向日葵" : "红玫瑰"),
            meaning: sent ? "真诚不变，温柔有回声" : (self ? "把明亮稳稳送给自己" : "热烈坚定，只偏爱你")
          },
          { name: "满天星", meaning: "藏在旁边，也认真发光" }
        ],
    comment: self ? "这束花很会爱自己" : (sent ? "这束花很会告白" : "这束花很会心动"),
    title: lateNight ? "晚风花" : self ? "给自己" : sent ? "春日信" : "花开了"
  };
}

export function mockGeneratedImage(originalImageUrl: string) {
  return originalImageUrl;
}
