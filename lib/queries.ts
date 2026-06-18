import { and, eq, desc } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  skus,
  zohoVendorCache,
  zohoCustomerCache,
  zohoPoCache,
  zohoInvoiceCache,
} from "@/lib/db/schema";

export type SkuOption = {
  id: number;
  code: string;
  name: string;
  channel: string;
  uom: string;
  packSizeText: string | null;
  motherSkuId: number | null;
};

const skuCols = {
  id: skus.id,
  code: skus.code,
  name: skus.name,
  channel: skus.channel,
  uom: skus.uom,
  packSizeText: skus.packSizeText,
  motherSkuId: skus.motherSkuId,
};

export async function motherSkus(): Promise<SkuOption[]> {
  return db
    .select(skuCols)
    .from(skus)
    .where(and(eq(skus.skuKind, "MOTHER"), eq(skus.isActive, true)))
    .orderBy(skus.code);
}

export async function packSkusByChannel(channel: string): Promise<SkuOption[]> {
  return db
    .select(skuCols)
    .from(skus)
    .where(
      and(
        eq(skus.skuKind, "DERIVATIVE"),
        eq(skus.channel, channel as never),
        eq(skus.isActive, true),
      ),
    )
    .orderBy(skus.code);
}

export async function allActiveSkus(): Promise<SkuOption[]> {
  return db
    .select(skuCols)
    .from(skus)
    .where(eq(skus.isActive, true))
    .orderBy(skus.code);
}

export async function vendors() {
  return db
    .select({ id: zohoVendorCache.id, name: zohoVendorCache.name })
    .from(zohoVendorCache)
    .where(eq(zohoVendorCache.isActive, true))
    .orderBy(zohoVendorCache.name);
}

export async function customers() {
  return db
    .select({ id: zohoCustomerCache.id, name: zohoCustomerCache.name })
    .from(zohoCustomerCache)
    .where(eq(zohoCustomerCache.isActive, true))
    .orderBy(zohoCustomerCache.name);
}

export async function openPurchaseOrders() {
  return db
    .select()
    .from(zohoPoCache)
    .orderBy(desc(zohoPoCache.poDate))
    .limit(200);
}

export async function recentInvoices(limit = 200) {
  return db
    .select({
      id: zohoInvoiceCache.id,
      zohoInvoiceId: zohoInvoiceCache.zohoInvoiceId,
      invoiceNumber: zohoInvoiceCache.invoiceNumber,
      customerName: zohoInvoiceCache.customerName,
      invoiceDate: zohoInvoiceCache.invoiceDate,
    })
    .from(zohoInvoiceCache)
    .orderBy(desc(zohoInvoiceCache.invoiceDate))
    .limit(limit);
}
