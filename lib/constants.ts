export const LOCATIONS = [
  { code: "COLD_ROOM", name: "Cold Room", kind: "COLD_ROOM" as const },
  { code: "DC_FLOOR_FG", name: "DC Floor – Finished Goods", kind: "DC_FLOOR_FG" as const },
  // v2: receipts land here; sorting is the only path into the Cold Room.
  { code: "RECEIVING_BAY", name: "Receiving Bay (unsorted)", kind: "RECEIVING_BAY" as const },
];

export const COLD_ROOM = "COLD_ROOM";
export const DC_FLOOR_FG = "DC_FLOOR_FG";
export const RECEIVING_BAY = "RECEIVING_BAY";

/**
 * Vendors that should never appear on the receiving sheet (non-produce: e.g.
 * equipment / maintenance suppliers whose POs come through from Zoho). Matched
 * case-insensitively as a substring of the PO's vendor name. Extend as needed.
 */
export const RECEIVING_VENDOR_DENYLIST = ["cold room engineers"];

/** Channels that have a DC Assembly sheet. */
export const ASSEMBLY_CHANNELS = [
  { key: "BULK_FRUIT", label: "Bulk Fruit", suffix: "-BF" },
  { key: "BLINKIT", label: "Blinkit", suffix: "BZ" },
  { key: "SPENCERS", label: "Spencer's", suffix: "S" },
] as const;

/** Wastage reason codes (free typing is never allowed — these are the dropdown). */
export const WASTAGE_REASONS = [
  { code: "SPOILAGE", label: "Spoilage / rot" },
  { code: "OVERRIPE", label: "Overripe" },
  { code: "DAMAGED_TRANSIT", label: "Damaged in transit" },
  { code: "MOULD_PEST", label: "Mould / pest / insect" },
  { code: "TEMPERATURE", label: "Temperature excursion" },
  { code: "EXPIRED_FEFO", label: "Expired / past shelf life" },
  { code: "QUALITY_REJECT", label: "Quality reject (grade-out)" },
  { code: "HANDLING_DAMAGE", label: "Handling damage" },
  { code: "LEAKAGE", label: "Leakage / bruising" },
  { code: "DEHYDRATION", label: "Dehydration / weight loss" },
  { code: "SORTING_LOSS", label: "Sorting loss" },
  { code: "OTHER", label: "Other" },
] as const;

export const WASTAGE_SOURCES = [
  "RECEIVING",
  "SORTING",
  "REGRADE",
  "ASSEMBLY",
  "RETURN",
  "EXPIRY",
  "GENERAL",
] as const;
