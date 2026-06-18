import { NextRequest, NextResponse } from "next/server";
import { and, asc, eq, gte, lte } from "drizzle-orm";
import { db } from "@/lib/db";
import { stockLedger, skus, users, locations } from "@/lib/db/schema";
import { getSession } from "@/lib/auth/session";
import { gradeComposition } from "@/lib/ledger/balance";

export const dynamic = "force-dynamic";

function csv(rows: (string | number | null)[][]): string {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const s = v == null ? "" : String(v);
          return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        })
        .join(","),
    )
    .join("\n");
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sheet: string }> },
) {
  const s = await getSession();
  if (!s) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { sheet } = await params;
  const from = req.nextUrl.searchParams.get("from") || undefined;
  const to = req.nextUrl.searchParams.get("to") || undefined;

  let out: string;
  let name: string;

  if (sheet === "grades") {
    const rows = await gradeComposition(from, to);
    out = csv([
      ["code", "name", "grade_a", "grade_b", "grade_c", "waste"],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...rows.map((r: any) => [r.code, r.name, r.grade_a, r.grade_b, r.grade_c, r.waste]),
    ]);
    name = "grade-composition";
  } else {
    // default: full immutable ledger (the universal audit export)
    const conds = [];
    if (from) conds.push(gte(stockLedger.businessDate, from));
    if (to) conds.push(lte(stockLedger.businessDate, to));
    const data = await db
      .select({
        businessDate: stockLedger.businessDate,
        createdAt: stockLedger.createdAt,
        movementType: stockLedger.movementType,
        code: skus.code,
        skuName: skus.name,
        location: locations.code,
        qty: stockLedger.qtySigned,
        balanceAfter: stockLedger.balanceAfter,
        docType: stockLedger.docType,
        docId: stockLedger.docId,
        user: users.fullName,
        note: stockLedger.note,
      })
      .from(stockLedger)
      .innerJoin(skus, eq(skus.id, stockLedger.skuId))
      .innerJoin(locations, eq(locations.id, stockLedger.locationId))
      .innerJoin(users, eq(users.id, stockLedger.userId))
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(stockLedger.id));
    out = csv([
      [
        "business_date",
        "timestamp_ist",
        "movement",
        "sku",
        "name",
        "location",
        "qty",
        "balance_after",
        "doc_type",
        "doc_id",
        "user",
        "note",
      ],
      ...data.map((r) => [
        r.businessDate,
        new Date(r.createdAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }),
        r.movementType,
        r.code,
        r.skuName,
        r.location,
        r.qty,
        r.balanceAfter,
        r.docType,
        r.docId,
        r.user,
        r.note,
      ]),
    ]);
    name = "ledger";
  }

  return new NextResponse(out, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="eat-${name}-${from ?? "all"}_${to ?? "all"}.csv"`,
    },
  });
}
