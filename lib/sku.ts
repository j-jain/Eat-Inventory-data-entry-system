/**
 * SKU code parsing — owned by THIS app (the legacy eat-os `pack_variant` column
 * is unreliable for BZ/SB derivatives, so channel is re-derived from the suffix).
 *
 * Codes: EAT046 (mother), EAT046-BF / "EAT046- BF" (bulk fruit), EAT046BZ (Blinkit),
 *        EAT005S (Spencer's), EAT005R (legacy retail), BE113 / SE007 (other families).
 * The numeric core EATnnn = the mother SKU; the suffix = channel/pack variant.
 */

export type Channel = "MOTHER" | "BULK_FRUIT" | "BLINKIT" | "SPENCERS" | "OTHER";
export type Uom = "kg" | "g" | "pc" | "box" | "bunch" | "unit";

const CORE_RE = /^(EAT|SE|BE)0*(\d+)/i;

/** Uppercase + strip ALL internal whitespace ("EAT001- BF" → "EAT001-BF"). */
export function normalizeCode(code: string): string {
  return code.toUpperCase().replace(/\s+/g, "");
}

/** The mother core, e.g. "EAT046-BF" → "EAT046", "EAT011BZ" → "EAT011". */
export function motherCore(code: string): string {
  const n = normalizeCode(code);
  const m = n.match(CORE_RE);
  if (!m) return n;
  // re-pad to 3 digits to match canonical mother codes (EAT046)
  const num = m[2].padStart(3, "0");
  return `${m[1].toUpperCase()}${num}`;
}

/** The suffix after the core, e.g. "EAT046-BF" → "-BF", "EAT011BZ" → "BZ". */
export function suffix(code: string): string {
  const n = normalizeCode(code);
  const m = n.match(CORE_RE);
  if (!m) return "";
  return n.slice(m[0].length);
}

/** Derive the channel. BASE/MOTHER SKUs are always MOTHER regardless of suffix. */
export function deriveChannel(code: string, isMother: boolean): Channel {
  if (isMother) return "MOTHER";
  const s = suffix(code).toUpperCase().replace(/^-/, "");
  if (s === "BF") return "BULK_FRUIT";
  if (s === "BZ") return "BLINKIT";
  if (s === "S" || s === "SB") return "SPENCERS";
  return "OTHER";
}

export type PackParse = {
  packGMin: string | null;
  packGMax: string | null;
  packPieces: string | null;
};

/**
 * Parse a free-text pack size into a gram band and/or a piece count.
 * Examples: "50 g", "1pc (200 - 300 g)", "500 - 600 g", "1 unit (100 g)",
 * "2pc", "6pcs", "1pc (250 g)", "700 g". Always lossless — raw text is kept too.
 */
export function parsePackSize(text: string | null | undefined): PackParse {
  const out: PackParse = { packGMin: null, packGMax: null, packPieces: null };
  if (!text) return out;
  const t = text.toLowerCase();

  // pieces: "2pc", "6pcs", "1 unit"
  const pc = t.match(/(\d+(?:\.\d+)?)\s*(?:pcs|pc|unit)/);
  if (pc) out.packPieces = pc[1];

  // gram range / single, possibly inside parentheses; supports kg
  const g = t.match(/(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?)\s*)?(kg|g)\b/);
  if (g) {
    const factor = g[3] === "kg" ? 1000 : 1;
    const lo = parseFloat(g[1]) * factor;
    const hi = g[2] ? parseFloat(g[2]) * factor : lo;
    out.packGMin = String(lo);
    out.packGMax = String(hi);
  }
  return out;
}

/** Map an eat-os unit string to our uom enum. */
export function mapUom(unit: string | null | undefined): Uom {
  const u = (unit ?? "").toLowerCase();
  if (u === "kg" || u === "kgs") return "kg";
  if (u === "g") return "g";
  if (u === "box" || u === "carton" || u === "crate") return "box";
  if (u === "bunch") return "bunch";
  if (u === "unit") return "unit";
  return "pc";
}
