/**
 * D() input-tolerance contract: number inputs hand back "" mid-edit, so
 * empty/whitespace strings must coerce to 0 in render math — while real
 * garbage keeps throwing so data bugs in qty/money columns stay loud.
 */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";

import { D, qtyStr, sumQty } from "@/lib/money";

describe("D() empty-input tolerance", () => {
  it("treats the empty string as 0 (mid-edit number input)", () => {
    expect(D("").toNumber()).toBe(0);
  });

  it("treats whitespace-only strings as 0", () => {
    expect(D("  ").toNumber()).toBe(0);
    expect(D("\t").toNumber()).toBe(0);
  });

  it("still throws on real garbage so data bugs stay loud", () => {
    expect(() => D("abc")).toThrow();
    expect(() => D("1.2.3")).toThrow();
    expect(() => D("-")).toThrow();
  });

  it("passes valid inputs through unchanged", () => {
    expect(D("1.5").toNumber()).toBe(1.5);
    expect(D(2).toNumber()).toBe(2);
    expect(D(new Decimal(3)).toNumber()).toBe(3);
    expect(D("-0.25").toNumber()).toBe(-0.25);
  });

  it("keeps null/undefined coercion", () => {
    expect(D(null as unknown as string).toNumber()).toBe(0);
    expect(D(undefined as unknown as string).toNumber()).toBe(0);
  });

  it("flows through aggregate helpers", () => {
    expect(sumQty(["1", "", "2"]).toFixed(3)).toBe("3.000");
    expect(qtyStr("")).toBe("0.000");
  });
});
