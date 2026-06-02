import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { cleanFlowerName } from "@/lib/validation";

type FlowerDetail = {
  name?: string;
  meaning?: string;
};

export async function GET() {
  const user = await getCurrentUser();
  const records = await prisma.flowerRecord.findMany({
    where: {
      ...(user ? { userId: user.id } : {})
    },
    select: { flowers: true }
  });

  const stats = new Map<string, { name: string; meaning: string; count: number }>();
  records.forEach(record => {
    const flowers = Array.isArray(record.flowers) ? record.flowers as FlowerDetail[] : [];
    flowers.forEach(flower => {
      const name = cleanFlowerName(flower.name || "");
      if (!name) return;
      const current = stats.get(name) || {
        name,
        meaning: flower.meaning || "一束被认真记住的花",
        count: 0
      };
      current.count += 1;
      if (flower.meaning) current.meaning = flower.meaning;
      stats.set(name, current);
    });
  });

  const flowers = Array.from(stats.values()).sort((a, b) => b.count - a.count);
  return NextResponse.json({ flowers });
}
