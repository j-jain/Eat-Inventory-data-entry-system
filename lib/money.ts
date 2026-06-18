import Decimal from "decimal.js";

Decimal.set({ precision: 30, rounding: Decimal.ROUND_HALF_UP });

export type Num = string | number | Decimal;

export const D = (x: Num): Decimal => new Decimal(x ?? 0);

export const add = (a: Num, b: Num) => D(a).plus(D(b));
export const sub = (a: Num, b: Num) => D(a).minus(D(b));
export const mul = (a: Num, b: Num) => D(a).times(D(b));
export const neg = (a: Num) => D(a).negated();

export const gt = (a: Num, b: Num) => D(a).gt(D(b));
export const gte = (a: Num, b: Num) => D(a).gte(D(b));
export const lt = (a: Num, b: Num) => D(a).lt(D(b));
export const lte = (a: Num, b: Num) => D(a).lte(D(b));
export const eq = (a: Num, b: Num) => D(a).eq(D(b));
export const isZero = (a: Num) => D(a).isZero();
export const isPos = (a: Num) => D(a).gt(0);

/** Canonical 3-decimal string for qty columns (numeric(14,3)). */
export const qtyStr = (a: Num) => D(a).toFixed(3);
/** Canonical 2-decimal string for money columns (numeric(14,2)). */
export const moneyStr = (a: Num) => D(a).toFixed(2);

/** Sum a list of qty-ish values, returns a Decimal. */
export const sumQty = (xs: Num[]) => xs.reduce<Decimal>((acc, x) => acc.plus(D(x)), D(0));
