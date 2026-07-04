import { and, eq, sql } from "drizzle-orm";
import {
  stockBalance,
  stockLedger,
  movementTypeEnum,
  uomEnum,
  docTypeEnum,
} from "@/lib/db/schema";
import { add, lt, neg, qtyStr, sub } from "@/lib/money";

export type Uom = (typeof uomEnum.enumValues)[number];
export type MovementType = (typeof movementTypeEnum.enumValues)[number];
export type DocType = (typeof docTypeEnum.enumValues)[number];

/** Any drizzle transaction handle (Neon or PGlite). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Tx = any;

export type MovementInput = {
  skuId: number;
  locationId: number;
  /** Signed decimal string: positive = into stock, negative = out of stock. */
  qtySigned: string;
  uom: Uom;
  movementType: MovementType;
  docLineId?: number | null;
  reversesLedgerId?: number | null;
  note?: string | null;
  /** ADMIN-only escape hatch for adjustments; never set by floor flows. */
  allowNegative?: boolean;
};

export type PostContext = {
  docType: DocType;
  docId: number;
  businessDate: string; // 'YYYY-MM-DD'
  userId: number;
};

/** Thrown when an out-movement would drive a balance below zero (hard block). */
export class HardBlockError extends Error {
  code = "HARD_BLOCK" as const;
  constructor(
    public skuId: number,
    public locationId: number,
    public available: string,
    public requested: string,
  ) {
    super(
      `Hard block: SKU ${skuId} @ location ${locationId} has only ${available} available, cannot draw ${requested}.`,
    );
    this.name = "HardBlockError";
  }
}

/**
 * Apply ONE movement atomically inside a transaction:
 *  1. ensure + lock the (sku, location) balance row (SELECT ... FOR UPDATE)
 *  2. compute new balance, hard-block if it would go negative
 *  3. append an immutable ledger row (balance_after snapshot)
 *  4. update the balance cache + last_movement_id
 *
 * Returns the inserted ledger row id.
 */
export async function applyMovement(
  tx: Tx,
  m: MovementInput,
  ctx: PostContext,
): Promise<number> {
  // 1. ensure the balance row exists, then lock it
  await tx
    .insert(stockBalance)
    .values({ skuId: m.skuId, locationId: m.locationId, qty: "0", uom: m.uom })
    .onConflictDoNothing({ target: [stockBalance.skuId, stockBalance.locationId] });

  const locked = await tx
    .select({ qty: stockBalance.qty })
    .from(stockBalance)
    .where(
      and(eq(stockBalance.skuId, m.skuId), eq(stockBalance.locationId, m.locationId)),
    )
    .for("update");

  const current = locked[0]?.qty ?? "0";
  const newBalance = add(current, m.qtySigned);

  // 2. hard block
  if (!m.allowNegative && lt(newBalance, 0)) {
    // out-movements are negative; report the magnitude drawn
    const requested = lt(m.qtySigned, 0) ? sub(0, m.qtySigned) : m.qtySigned;
    throw new HardBlockError(
      m.skuId,
      m.locationId,
      qtyStr(current),
      qtyStr(requested),
    );
  }

  // 3. append immutable ledger row
  const [led] = await tx
    .insert(stockLedger)
    .values({
      movementType: m.movementType,
      skuId: m.skuId,
      locationId: m.locationId,
      qtySigned: qtyStr(m.qtySigned),
      uom: m.uom,
      balanceAfter: qtyStr(newBalance),
      docType: ctx.docType,
      docId: ctx.docId,
      docLineId: m.docLineId ?? null,
      reversesLedgerId: m.reversesLedgerId ?? null,
      businessDate: ctx.businessDate,
      userId: ctx.userId,
      note: m.note ?? null,
    })
    .returning({ id: stockLedger.id });

  // 4. update balance cache
  await tx
    .update(stockBalance)
    .set({ qty: qtyStr(newBalance), lastMovementId: led.id, updatedAt: new Date() })
    .where(
      and(eq(stockBalance.skuId, m.skuId), eq(stockBalance.locationId, m.locationId)),
    );

  return led.id;
}

/**
 * Apply a list of movements in deterministic key order (avoids deadlocks
 * between two concurrent multi-line documents locking the same rows).
 */
export async function applyMovements(
  tx: Tx,
  movements: MovementInput[],
  ctx: PostContext,
): Promise<number[]> {
  const ordered = [...movements].sort(
    (a, b) => a.skuId - b.skuId || a.locationId - b.locationId,
  );
  const ids: number[] = [];
  for (const m of ordered) {
    if (qtyStr(m.qtySigned) === "0.000") continue; // skip no-op movements
    ids.push(await applyMovement(tx, m, ctx));
  }
  return ids;
}

/**
 * Void a posted document: flip status to VOIDED and post exact reversing
 * entries for every ledger row of that document. Refuses if any downstream
 * movement already depends on the stock this document created (e.g. a receipt
 * whose stock was assembled) — checked by the reversal itself hard-blocking
 * (the reversal of an in-movement is an out-movement, which can't go negative).
 */
export async function voidDocumentLedger(
  tx: Tx,
  docType: DocType,
  docId: number,
  ctx: { userId: number; businessDate: string; reason: string },
): Promise<number[]> {
  const rows = await tx
    .select()
    .from(stockLedger)
    .where(and(eq(stockLedger.docType, docType), eq(stockLedger.docId, docId)));

  const reversals: { src: (typeof rows)[number] }[] = rows
    .filter((r: { movementType: MovementType }) => r.movementType !== "VOID_REVERSAL")
    .map((r: (typeof rows)[number]) => ({ src: r }));

  const ids: number[] = [];
  for (const { src } of reversals) {
    const id = await applyMovement(
      tx,
      {
        skuId: src.skuId,
        locationId: src.locationId,
        // decimal negation — string-prefixing "-" breaks on negative rows
        qtySigned: qtyStr(neg(src.qtySigned)),
        uom: src.uom,
        movementType: "VOID_REVERSAL",
        reversesLedgerId: src.id,
        note: `void: ${ctx.reason}`,
      },
      { docType, docId, businessDate: ctx.businessDate, userId: ctx.userId },
    );
    ids.push(id);
  }
  return ids;
}
