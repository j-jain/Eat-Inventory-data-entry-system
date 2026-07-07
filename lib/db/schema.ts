import {
  pgTable,
  pgEnum,
  bigint,
  text,
  boolean,
  integer,
  numeric,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  unique,
  check,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/* =========================================================================
 * Enums
 * =======================================================================*/
export const userRoleEnum = pgEnum("user_role", [
  "FLOOR",
  "SUPERVISOR",
  "ADMIN",
  "MANAGER", // appended (enum order is irrelevant — ranking lives in lib/auth/rbac.ts)
]);
export const skuKindEnum = pgEnum("sku_kind", ["MOTHER", "DERIVATIVE"]);
export const channelEnum = pgEnum("channel", [
  "MOTHER",
  "BULK_FRUIT",
  "BLINKIT",
  "SPENCERS",
  "OTHER",
]);
export const uomEnum = pgEnum("uom", ["kg", "g", "pc", "box", "bunch", "unit"]);
export const locationKindEnum = pgEnum("location_kind", [
  "COLD_ROOM",
  "DC_FLOOR_FG",
  "VIRTUAL",
  "RECEIVING_BAY",
]);
export const movementTypeEnum = pgEnum("movement_type", [
  "OPENING_BALANCE",
  "RECEIPT",
  "SORT_WASTE",
  "REGRADE_WASTE",
  "ASSEMBLY_CONSUME",
  "PACK_PRODUCE",
  "DISPATCH",
  "RETURN_TO_MOTHER",
  "RETURN_WASTE",
  "WASTAGE",
  "ADJUSTMENT_PLUS",
  "ADJUSTMENT_MINUS",
  "VOID_REVERSAL",
  // v2: sorting is a transfer Receiving Bay → Cold Room (waste stays explicit)
  "SORT_OUT", // bay −(A+B+C), the good portion leaving the bay
  "SORT_IN", // cold room +(A+B+C)
]);
export const docTypeEnum = pgEnum("doc_type", [
  "RECEIVING",
  "SORTING",
  "ASSEMBLY",
  "WASTAGE",
  "RETURN",
  "INV_ADJUSTMENT",
  "DISPATCH",
  "PURCHASE_ORDER",
  "OPENING",
  "MANUAL_ORDER",
  "PO_DRAFT",
  "PICK_LIST",
]);
export const docStatusEnum = pgEnum("doc_status", ["DRAFT", "POSTED", "VOIDED"]);
export const returnDispEnum = pgEnum("return_disposition", ["RESALABLE", "WASTE"]);
export const wastageSourceEnum = pgEnum("wastage_source", [
  "SORTING",
  "REGRADE",
  "ASSEMBLY",
  "RETURN",
  "EXPIRY",
  "GENERAL",
  "RECEIVING",
]);
export const adjKindEnum = pgEnum("adj_kind", ["TIE_OUT", "OVERRIDE", "MANUAL"]);
export const returnMatchEnum = pgEnum("return_match", ["MATCHED", "PENDING_MATCH"]);
export const pickListStatusEnum = pgEnum("pick_list_status", [
  "OPEN",
  "COMPLETED",
  "CANCELLED",
]);
export const pickSourceTypeEnum = pgEnum("pick_source_type", [
  "ZOHO_SO",
  "MANUAL_ORDER",
]);
export const deliveryStatusEnum = pgEnum("delivery_status", [
  "PENDING",
  "PARTIAL",
  "DELIVERED",
]);
export const receivingVarianceEnum = pgEnum("receiving_variance", [
  "NONE",
  "S1_FREE_LEFTOVER", // short receipt + vendor leaves the rest free (₹0)
  "S2_OVER_RECEIPT", // vendor supplied more than ordered
  "S4_SHORT_BILLED_FULL", // short receipt but billed full — missing qty → wastage
]);

/* Money/qty helpers */
const qty = (name: string) => numeric(name, { precision: 14, scale: 3 });
const money = (name: string) => numeric(name, { precision: 14, scale: 2 });

/* =========================================================================
 * Users
 * =======================================================================*/
export const users = pgTable(
  "users",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    fullName: text("full_name").notNull(),
    pinHash: text("pin_hash").notNull(),
    /** PIN encrypted at rest (AES-GCM, key derived from SESSION_SECRET) so
     *  admins can view/edit it — a DB dump alone can't reveal PINs. The
     *  bcrypt hash above stays the verify path. */
    pinEnc: text("pin_enc"),
    role: userRoleEnum("role").notNull().default("FLOOR"),
    /** Per-user page allow-list (href keys). NULL = the role's default set. */
    allowedPages: jsonb("allowed_pages"),
    attempts: integer("attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("uq_users_name").on(sql`lower(${t.fullName})`)],
);

/* =========================================================================
 * SKU master
 * =======================================================================*/
export const skus = pgTable(
  "skus",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    code: text("code").notNull(),
    normalizedCode: text("normalized_code").notNull(),
    name: text("name").notNull(),
    family: text("family").notNull().default("EAT"),
    skuKind: skuKindEnum("sku_kind").notNull(),
    channel: channelEnum("channel").notNull(),
    motherSkuId: bigint("mother_sku_id", { mode: "number" }).references(
      (): AnyPgColumn => skus.id,
    ),
    motherCore: text("mother_core").notNull(),
    packSizeText: text("pack_size_text"),
    packGMin: qty("pack_g_min"),
    packGMax: qty("pack_g_max"),
    packPieces: numeric("pack_pieces", { precision: 10, scale: 2 }),
    uom: uomEnum("uom").notNull(),
    category: text("category").default(""),
    shelfLifeDays: integer("shelf_life_days"),
    zohoItemId: text("zoho_item_id"),
    source: text("source").notNull().default("LOCAL"), // LOCAL | ZOHO
    /** false = skips the Receiving Bay (non-graded goods, e.g. cheese) */
    requiresSorting: boolean("requires_sorting").notNull().default(true),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("uq_skus_code").on(t.code),
    uniqueIndex("uq_skus_normalized").on(t.normalizedCode),
    index("idx_skus_mother").on(t.motherSkuId),
    index("idx_skus_mother_core").on(t.motherCore),
    index("idx_skus_zoho").on(t.zohoItemId),
    index("idx_skus_channel").on(t.channel),
  ],
);

/* =========================================================================
 * Locations
 * =======================================================================*/
export const locations = pgTable("locations", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  code: text("code").notNull().unique(),
  name: text("name").notNull(),
  kind: locationKindEnum("kind").notNull(),
  isActive: boolean("is_active").notNull().default(true),
});

/* =========================================================================
 * Stock balance (mutable cache, one row per (sku, location))
 * =======================================================================*/
export const stockBalance = pgTable(
  "stock_balance",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    skuId: bigint("sku_id", { mode: "number" })
      .notNull()
      .references(() => skus.id),
    locationId: bigint("location_id", { mode: "number" })
      .notNull()
      .references(() => locations.id),
    qty: qty("qty").notNull().default("0"),
    uom: uomEnum("uom").notNull(),
    lastMovementId: bigint("last_movement_id", { mode: "number" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique("uq_balance_key").on(t.skuId, t.locationId),
    check("ck_balance_nonneg", sql`${t.qty} >= 0`),
  ],
);

/* =========================================================================
 * Stock ledger (append-only — the single source of truth)
 * =======================================================================*/
export const stockLedger = pgTable(
  "stock_ledger",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    movementType: movementTypeEnum("movement_type").notNull(),
    skuId: bigint("sku_id", { mode: "number" })
      .notNull()
      .references(() => skus.id),
    locationId: bigint("location_id", { mode: "number" })
      .notNull()
      .references(() => locations.id),
    qtySigned: qty("qty_signed").notNull(), // +in / -out
    uom: uomEnum("uom").notNull(),
    balanceAfter: qty("balance_after").notNull(),
    docType: docTypeEnum("doc_type").notNull(),
    docId: bigint("doc_id", { mode: "number" }).notNull(),
    docLineId: bigint("doc_line_id", { mode: "number" }),
    reversesLedgerId: bigint("reverses_ledger_id", { mode: "number" }).references(
      (): AnyPgColumn => stockLedger.id,
    ),
    businessDate: date("business_date").notNull(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    note: text("note"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_ledger_balkey").on(t.skuId, t.locationId, t.id),
    index("idx_ledger_doc").on(t.docType, t.docId),
    index("idx_ledger_bizdate").on(t.businessDate),
    index("idx_ledger_type").on(t.movementType),
    check("ck_ledger_qty_nonzero", sql`${t.qtySigned} <> 0`),
  ],
);

/* =========================================================================
 * Document header column factory (shared across all sheet docs)
 * =======================================================================*/
const docHeaderCols = () => ({
  docStatus: docStatusEnum("doc_status").notNull().default("DRAFT"),
  businessDate: date("business_date").notNull(),
  note: text("note"),
  createdByUserId: bigint("created_by_user_id", { mode: "number" })
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  clientToken: text("client_token"),
  voidedByUserId: bigint("voided_by_user_id", { mode: "number" }),
  voidedAt: timestamp("voided_at", { withTimezone: true }),
  voidReason: text("void_reason"),
});

/* ---- Receiving ---- */
export const receivingDoc = pgTable(
  "receiving_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    vendorId: bigint("vendor_id", { mode: "number" }),
    poNo: text("po_no"),
    prNo: text("pr_no"),
    zohoPoId: text("zoho_po_id"),
    variance: receivingVarianceEnum("variance").notNull().default("NONE"),
    varianceNote: text("variance_note"),
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_receiving_token").on(t.clientToken)],
);
export const receivingLine = pgTable(
  "receiving_line",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    docId: bigint("doc_id", { mode: "number" })
      .notNull()
      .references(() => receivingDoc.id),
    skuId: bigint("sku_id", { mode: "number" })
      .notNull()
      .references(() => skus.id),
    acceptedQty: qty("accepted_qty").notNull(),
    poExpectedQty: qty("po_expected_qty"),
    uom: uomEnum("uom").notNull().default("kg"),
    notes: text("notes"),
  },
  // cumulative-received SUM per (PO, sku) — see openPurchaseOrdersForReceiving
  (t) => [index("idx_receiving_line_doc_sku").on(t.docId, t.skuId)],
);

/* ---- Sorting (A/B/C data; waste auto-computed) ---- */
export const sortingDoc = pgTable(
  "sorting_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    isRecheck: boolean("is_recheck").notNull().default(false),
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_sorting_token").on(t.clientToken)],
);
export const sortingLine = pgTable(
  "sorting_line",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    docId: bigint("doc_id", { mode: "number" })
      .notNull()
      .references(() => sortingDoc.id),
    skuId: bigint("sku_id", { mode: "number" })
      .notNull()
      .references(() => skus.id),
    sortedQty: qty("sorted_qty").notNull(),
    qtyA: qty("qty_a").notNull().default("0"),
    qtyB: qty("qty_b").notNull().default("0"),
    qtyC: qty("qty_c").notNull().default("0"),
    // waste auto-computed = sorted_qty - (a + b + c)
    qtyWaste: qty("qty_waste").generatedAlwaysAs(
      sql`sorted_qty - (qty_a + qty_b + qty_c)`,
    ),
  },
  (t) => [
    check("ck_sorting_split", sql`${t.qtyA} + ${t.qtyB} + ${t.qtyC} <= ${t.sortedQty}`),
  ],
);

/* ---- Assembly (BF/BZ/S) ---- */
export const assemblyDoc = pgTable(
  "assembly_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    channel: channelEnum("channel").notNull(),
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_assembly_token").on(t.clientToken)],
);
export const assemblyLine = pgTable(
  "assembly_line",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    docId: bigint("doc_id", { mode: "number" })
      .notNull()
      .references(() => assemblyDoc.id),
    motherSkuId: bigint("mother_sku_id", { mode: "number" })
      .notNull()
      .references(() => skus.id),
    packSkuId: bigint("pack_sku_id", { mode: "number" })
      .notNull()
      .references(() => skus.id),
    qtyOut: qty("qty_out").notNull(),
    qtyIn: qty("qty_in").notNull().default("0"),
    totalUsed: qty("total_used").notNull(),
    packsMade: numeric("packs_made", { precision: 12, scale: 2 }).notNull(),
    packSizeText: text("pack_size_text"),
    qtyWaste: qty("qty_waste").notNull().default("0"),
  },
  (t) => [
    check("ck_assembly_used", sql`${t.totalUsed} = ${t.qtyOut} - ${t.qtyIn}`),
    check("ck_assembly_in_le_out", sql`${t.qtyIn} <= ${t.qtyOut}`),
    check(
      "ck_assembly_waste",
      sql`${t.qtyWaste} >= 0 AND ${t.qtyWaste} <= ${t.totalUsed}`,
    ),
  ],
);

/* ---- Wastage (hub) ---- */
export const wastageDoc = pgTable(
  "wastage_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_wastage_token").on(t.clientToken)],
);
export const wastageLine = pgTable("wastage_line", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  docId: bigint("doc_id", { mode: "number" })
    .notNull()
    .references(() => wastageDoc.id),
  skuId: bigint("sku_id", { mode: "number" })
    .notNull()
    .references(() => skus.id),
  locationId: bigint("location_id", { mode: "number" })
    .notNull()
    .references(() => locations.id),
  qty: qty("qty").notNull(),
  uom: uomEnum("uom").notNull(),
  reason: text("reason").notNull(),
  source: wastageSourceEnum("source").notNull().default("GENERAL"),
  sourceDocType: docTypeEnum("source_doc_type"),
  sourceDocId: bigint("source_doc_id", { mode: "number" }),
});

/* ---- Return ---- */
export const returnDoc = pgTable(
  "return_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    customerId: bigint("customer_id", { mode: "number" }),
    zohoInvoiceId: text("zoho_invoice_id"),
    invNo: text("inv_no"),
    matchStatus: returnMatchEnum("match_status").notNull().default("PENDING_MATCH"),
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_return_token").on(t.clientToken)],
);
export const returnLine = pgTable("return_line", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  docId: bigint("doc_id", { mode: "number" })
    .notNull()
    .references(() => returnDoc.id),
  skuId: bigint("sku_id", { mode: "number" })
    .notNull()
    .references(() => skus.id),
  qtyReturn: qty("qty_return").notNull(),
  qtyWeight: qty("qty_weight").notNull().default("0"),
  backToMotherSkuId: bigint("back_to_mother_sku_id", { mode: "number" }).references(
    () => skus.id,
  ),
  disposition: returnDispEnum("disposition").notNull(),
  uom: uomEnum("uom").notNull(),
});

/* ---- Inventory adjustment ---- */
export const invAdjustmentDoc = pgTable(
  "inv_adjustment_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    vendorId: bigint("vendor_id", { mode: "number" }),
    against: text("against"),
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_invadj_token").on(t.clientToken)],
);
export const invAdjustmentLine = pgTable("inv_adjustment_line", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  docId: bigint("doc_id", { mode: "number" })
    .notNull()
    .references(() => invAdjustmentDoc.id),
  skuId: bigint("sku_id", { mode: "number" })
    .notNull()
    .references(() => skus.id),
  locationId: bigint("location_id", { mode: "number" })
    .notNull()
    .references(() => locations.id),
  qtyAsPerPo: qty("qty_as_per_po"),
  actualReceived: qty("actual_received"),
  qtyAsPerBill: qty("qty_as_per_bill"),
  qtyToAdjust: qty("qty_to_adjust").notNull(),
  adjKind: adjKindEnum("adj_kind").notNull().default("MANUAL"),
  unitCost: money("unit_cost").default("0"),
  reason: text("reason"),
});

/* ---- Dispatch (shipment + delivery confirmation) ---- */
export const dispatchDoc = pgTable(
  "dispatch_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    customerId: bigint("customer_id", { mode: "number" }),
    channel: channelEnum("channel"),
    dispatchRef: text("dispatch_ref"),
    pickListId: bigint("pick_list_id", { mode: "number" }).references(
      (): AnyPgColumn => pickList.id,
    ),
    deliveryStatus: deliveryStatusEnum("delivery_status").notNull().default("PENDING"),
    deliveredAt: timestamp("delivered_at", { withTimezone: true }),
    deliveredByUserId: bigint("delivered_by_user_id", { mode: "number" }),
    deliveryNote: text("delivery_note"),
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_dispatch_token").on(t.clientToken)],
);
export const dispatchLine = pgTable(
  "dispatch_line",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    docId: bigint("doc_id", { mode: "number" })
      .notNull()
      .references(() => dispatchDoc.id),
    packSkuId: bigint("pack_sku_id", { mode: "number" })
      .notNull()
      .references(() => skus.id),
    qty: qty("qty").notNull(),
    uom: uomEnum("uom").notNull(),
    deliveredQty: qty("delivered_qty").notNull().default("0"),
  },
  (t) => [
    check(
      "ck_dispatch_delivered",
      sql`${t.deliveredQty} >= 0 AND ${t.deliveredQty} <= ${t.qty}`,
    ),
  ],
);

/* =========================================================================
 * Orders & Pick List (v2)
 * =======================================================================*/

/** Manually entered customer orders (channels that don't flow through Zoho). */
export const manualOrderDoc = pgTable(
  "manual_order_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    customerId: bigint("customer_id", { mode: "number" }),
    channel: channelEnum("channel"),
    orderRef: text("order_ref"),
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_manual_order_token").on(t.clientToken)],
);
export const manualOrderLine = pgTable("manual_order_line", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  docId: bigint("doc_id", { mode: "number" })
    .notNull()
    .references(() => manualOrderDoc.id),
  skuId: bigint("sku_id", { mode: "number" })
    .notNull()
    .references(() => skus.id),
  qty: qty("qty").notNull(),
  uom: uomEnum("uom").notNull(),
});

/**
 * The mandatory Pick List. At most ONE list can be OPEN at a time (partial
 * unique index). Assembly/Dispatch are gated on: at least one list generated
 * today AND no list OPEN (see lib/workflow.ts).
 */
export const pickList = pgTable(
  "pick_list",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    businessDate: date("business_date").notNull(),
    status: pickListStatusEnum("status").notNull().default("OPEN"),
    note: text("note"),
    createdByUserId: bigint("created_by_user_id", { mode: "number" })
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    clientToken: text("client_token"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    completedByUserId: bigint("completed_by_user_id", { mode: "number" }),
    /** Set when completed short (SUPERVISOR+); surfaced on the Summary sheet. */
    shortCompleteReason: text("short_complete_reason"),
  },
  (t) => [
    uniqueIndex("uq_pick_list_token").on(t.clientToken),
    // max one OPEN list system-wide
    uniqueIndex("uq_pick_list_single_open")
      .on(t.status)
      .where(sql`${t.status} = 'OPEN'`),
    index("idx_pick_list_date").on(t.businessDate),
  ],
);
export const pickListLine = pgTable(
  "pick_list_line",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    pickListId: bigint("pick_list_id", { mode: "number" })
      .notNull()
      .references(() => pickList.id),
    skuId: bigint("sku_id", { mode: "number" })
      .notNull()
      .references(() => skus.id),
    qtyToPick: qty("qty_to_pick").notNull(),
    qtyPicked: qty("qty_picked").notNull().default("0"),
    uom: uomEnum("uom").notNull(),
  },
  (t) => [
    unique("uq_pick_list_line").on(t.pickListId, t.skuId),
    check("ck_pick_picked_nonneg", sql`${t.qtyPicked} >= 0`),
  ],
);
/** Which orders fed a pick list — an order can only ever feed one list. */
export const pickListSource = pgTable(
  "pick_list_source",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    pickListId: bigint("pick_list_id", { mode: "number" })
      .notNull()
      .references(() => pickList.id),
    sourceType: pickSourceTypeEnum("source_type").notNull(),
    zohoSoId: text("zoho_so_id"),
    manualOrderDocId: bigint("manual_order_doc_id", { mode: "number" }).references(
      () => manualOrderDoc.id,
    ),
    /** human order number snapshot (SO-00042 / manual #7) for grouped views */
    orderNo: text("order_no"),
    /** false = the order was consumed but NONE of its lines matched a local
     *  SKU — surfaced as a warning on the pick list instead of silently lost */
    matched: boolean("matched").notNull().default(true),
  },
  (t) => [
    uniqueIndex("uq_pick_source_so").on(t.zohoSoId),
    uniqueIndex("uq_pick_source_manual").on(t.manualOrderDocId),
    check(
      "ck_pick_source_one_ref",
      sql`(${t.sourceType} = 'ZOHO_SO' AND ${t.zohoSoId} IS NOT NULL AND ${t.manualOrderDocId} IS NULL)
       OR (${t.sourceType} = 'MANUAL_ORDER' AND ${t.manualOrderDocId} IS NOT NULL AND ${t.zohoSoId} IS NULL)`,
    ),
  ],
);

/** Per-line provenance: which order contributed how much to each pick-list
 *  line — captured at Generate time so the list can be viewed Zoho-style
 *  (no grouping / by item / by sales order) without regenerating. */
export const pickListLineSource = pgTable(
  "pick_list_line_source",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    pickListLineId: bigint("pick_list_line_id", { mode: "number" })
      .notNull()
      .references(() => pickListLine.id),
    sourceType: pickSourceTypeEnum("source_type").notNull(),
    zohoSoId: text("zoho_so_id"),
    manualOrderDocId: bigint("manual_order_doc_id", { mode: "number" }).references(
      () => manualOrderDoc.id,
    ),
    orderNo: text("order_no"),
    qty: qty("qty").notNull(),
  },
  (t) => [index("idx_plls_line").on(t.pickListLineId)],
);

/* =========================================================================
 * Local PO drafts (Aniket) — pushed to Zoho as draft Purchase Orders
 * =======================================================================*/
export const poDraftDoc = pgTable(
  "po_draft_doc",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    vendorZohoId: text("vendor_zoho_id"),
    vendorName: text("vendor_name"),
    deliveryDate: date("delivery_date"),
    zohoPoId: text("zoho_po_id"), // set once pushed
    pushStatus: text("push_status").notNull().default("LOCAL"), // LOCAL | PUSHED
    ...docHeaderCols(),
  },
  (t) => [uniqueIndex("uq_po_draft_token").on(t.clientToken)],
);
export const poDraftLine = pgTable("po_draft_line", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  docId: bigint("doc_id", { mode: "number" })
    .notNull()
    .references(() => poDraftDoc.id),
  skuId: bigint("sku_id", { mode: "number" })
    .notNull()
    .references(() => skus.id),
  qty: qty("qty").notNull(),
  rate: money("rate"),
  uom: uomEnum("uom").notNull(),
});

/* ---- Opening balance ---- */
export const openingDoc = pgTable("opening_doc", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  ...docHeaderCols(),
});

/* =========================================================================
 * Zoho read-only cache tables
 * =======================================================================*/
export const zohoToken = pgTable("zoho_token", {
  id: integer("id").primaryKey().default(1),
  accessToken: text("access_token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const zohoItemCache = pgTable("zoho_item_cache", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  zohoItemId: text("zoho_item_id").notNull().unique(),
  itemName: text("item_name"),
  skuText: text("sku_text"),
  stockOnHand: qty("stock_on_hand"),
  rate: money("rate"),
  lastModifiedTime: text("last_modified_time"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

export const zohoVendorCache = pgTable("zoho_vendor_cache", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  zohoContactId: text("zoho_contact_id").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

export const zohoCustomerCache = pgTable("zoho_customer_cache", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  zohoContactId: text("zoho_contact_id").notNull().unique(),
  name: text("name").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

export const zohoPoCache = pgTable("zoho_po_cache", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  zohoPoId: text("zoho_po_id").notNull().unique(),
  poNumber: text("po_number"),
  vendorZohoId: text("vendor_zoho_id"),
  vendorName: text("vendor_name"),
  poDate: date("po_date"),
  status: text("status"),
  // Zoho receive status: pending | partially_received | received. Nullable —
  // rows synced before this column existed backfill on the next full PO sync.
  receivedStatus: text("received_status"),
  lineItems: jsonb("line_items"),
  lastModifiedTime: text("last_modified_time"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Open sales orders (feed the Pick List) — mirrors zoho_po_cache. */
export const zohoSoCache = pgTable("zoho_so_cache", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  zohoSoId: text("zoho_so_id").notNull().unique(),
  soNumber: text("so_number"),
  customerZohoId: text("customer_zoho_id"),
  customerName: text("customer_name"),
  soDate: date("so_date"),
  status: text("status"),
  lineItems: jsonb("line_items"),
  lastModifiedTime: text("last_modified_time"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
});

export const zohoInvoiceCache = pgTable(
  "zoho_invoice_cache",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    zohoInvoiceId: text("zoho_invoice_id").notNull().unique(),
    invoiceNumber: text("invoice_number"),
    customerZohoId: text("customer_zoho_id"),
    customerName: text("customer_name"),
    invoiceDate: date("invoice_date"),
    lineItems: jsonb("line_items"),
    lastModifiedTime: text("last_modified_time"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_inv_number").on(t.invoiceNumber),
    index("idx_inv_customer").on(t.customerZohoId),
  ],
);

export const syncLog = pgTable("sync_log", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entity: text("entity").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  rowsPulled: integer("rows_pulled").default(0),
  status: text("status").notNull().default("RUNNING"),
  error: text("error"),
});

/* App-level audit (non-stock events: logins, voids, sync, config) */
export const appAuditLog = pgTable(
  "app_audit_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint("user_id", { mode: "number" }),
    action: text("action").notNull(),
    docType: text("doc_type"),
    docId: bigint("doc_id", { mode: "number" }),
    payload: jsonb("payload"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  // Zoho push idempotency + push-status lookups (Review queue)
  (t) => [index("idx_audit_action_doc").on(t.action, t.docType, t.docId)],
);

/* =========================================================================
 * Zoho push state (v3) — the single source of truth for "did this document
 * reach Zoho". One row per outbound Zoho create (sub_key distinguishes the
 * per-line requests of a bundle push). The audit log keeps the trail; THIS
 * table keeps the state. po.update is deliberately absent — PO edits
 * legitimately repeat and have no create-once lifecycle.
 * =======================================================================*/
export const zohoPush = pgTable(
  "zoho_push",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    kind: text("kind").notNull(), // ZohoPushKind minus po.update
    docType: text("doc_type").notNull(),
    docId: bigint("doc_id", { mode: "number" }).notNull(),
    subKey: text("sub_key").notNull().default("doc"),
    /** Reference stamped into the Zoho payload — what the reconciler searches for. */
    idemRef: text("idem_ref"),
    status: text("status").notNull().default("PENDING"),
    attempts: integer("attempts").notNull().default(0),
    zohoId: text("zoho_id"),
    /** Human document number on Zoho's side (bill number, PO number, …). */
    zohoNumber: text("zoho_number"),
    error: text("error"),
    requestPayload: jsonb("request_payload"),
    zohoResponse: jsonb("zoho_response"),
    createdBy: bigint("created_by", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    pushedAt: timestamp("pushed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("uq_zoho_push_key").on(t.kind, t.docType, t.docId, t.subKey),
    index("idx_zoho_push_status").on(t.status),
    index("idx_zoho_push_doc").on(t.docType, t.docId),
    check(
      "ck_zoho_push_status",
      sql`${t.status} IN ('PENDING','IN_FLIGHT','SUCCESS','FAILED','UNKNOWN','SKIPPED')`,
    ),
  ],
);

/* Structured system/error log feeding the developer dashboard. */
export const systemLog = pgTable(
  "system_log",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    level: text("level").notNull(), // INFO | WARN | ERROR
    source: text("source").notNull(), // action/route name, e.g. "zoho-drafts.pushToZoho"
    message: text("message").notNull(),
    ctx: jsonb("ctx"),
    userId: bigint("user_id", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index("idx_system_log_level_time").on(t.level, t.createdAt),
    index("idx_system_log_source_time").on(t.source, t.createdAt),
  ],
);

/* Daily Zoho API budget meter (Standard plan: 2,000 calls/day, 100/min). */
export const zohoCallCounter = pgTable("zoho_call_counter", {
  day: date("day").primaryKey(), // IST date
  calls: integer("calls").notNull().default(0),
  writes: integer("writes").notNull().default(0),
});

/* Singleton mutex row for the cron sync (pooler-safe alternative to
 * advisory locks — pgBouncer transaction pooling breaks session locks). */
export const syncMutex = pgTable("sync_mutex", {
  id: integer("id").primaryKey().default(1),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
});
