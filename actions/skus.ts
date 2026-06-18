"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { skus } from "@/lib/db/schema";
import { requireAdmin } from "@/lib/auth/rbac";
import {
  normalizeCode,
  motherCore,
  deriveChannel,
  parsePackSize,
} from "@/lib/sku";

export async function setSkuActive(skuId: number, active: boolean) {
  await requireAdmin();
  await db.update(skus).set({ isActive: active }).where(eq(skus.id, skuId));
  revalidatePath("/admin/skus");
  return { ok: true as const };
}

export type AddSkuInput = {
  code: string;
  name: string;
  kind: "MOTHER" | "DERIVATIVE";
  uom: "kg" | "g" | "pc" | "box" | "bunch" | "unit";
  packText?: string;
};

export async function addSku(
  input: AddSkuInput,
): Promise<{ ok: true; id: number } | { ok: false; error: string }> {
  await requireAdmin();
  const code = input.code.trim();
  if (!code || !input.name.trim()) return { ok: false, error: "Code and name required." };
  const norm = normalizeCode(code);
  const isMother = input.kind === "MOTHER";
  const pack = parsePackSize(input.packText);
  try {
    const [row] = await db
      .insert(skus)
      .values({
        code,
        normalizedCode: norm,
        name: input.name.trim(),
        family: norm.match(/^[A-Z]+/)?.[0] ?? "EAT",
        skuKind: input.kind,
        channel: deriveChannel(code, isMother),
        motherCore: motherCore(code),
        packSizeText: input.packText || null,
        packGMin: pack.packGMin,
        packGMax: pack.packGMax,
        packPieces: pack.packPieces,
        uom: input.uom,
        source: "LOCAL",
        isActive: true,
      })
      .returning({ id: skus.id });

    // link mother if derivative
    if (!isMother) {
      const mc = motherCore(code);
      const mom = await db
        .select({ id: skus.id })
        .from(skus)
        .where(eq(skus.normalizedCode, mc));
      if (mom[0]) await db.update(skus).set({ motherSkuId: mom[0].id }).where(eq(skus.id, row.id));
    }
    revalidatePath("/admin/skus");
    return { ok: true, id: row.id };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
