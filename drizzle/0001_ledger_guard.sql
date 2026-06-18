-- Append-only guarantee for stock_ledger: no UPDATE, no DELETE, ever.
-- Corrections happen via new VOID_REVERSAL rows, never by mutating history.

CREATE OR REPLACE FUNCTION eat_block_ledger_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'stock_ledger is append-only: % is not allowed (use a VOID_REVERSAL row)', TG_OP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_ledger_no_update ON stock_ledger;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_no_update
  BEFORE UPDATE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION eat_block_ledger_mutation();
--> statement-breakpoint

DROP TRIGGER IF EXISTS trg_ledger_no_delete ON stock_ledger;
--> statement-breakpoint
CREATE TRIGGER trg_ledger_no_delete
  BEFORE DELETE ON stock_ledger
  FOR EACH ROW EXECUTE FUNCTION eat_block_ledger_mutation();
--> statement-breakpoint

-- Guard: at most one OPENING_BALANCE per (sku, location) so re-running the
-- opening-balance seeder can never double-seed.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_one_opening
  ON stock_ledger (sku_id, location_id)
  WHERE movement_type = 'OPENING_BALANCE';
