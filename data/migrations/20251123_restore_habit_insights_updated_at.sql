-- Ensure habit_insights table matches Prisma schema expectations
ALTER TABLE habit_insights
  ADD COLUMN IF NOT EXISTS updated_at timestamptz(6);

-- Backfill existing rows so NOT NULL constraint can be enforced safely
UPDATE habit_insights
SET updated_at = COALESCE(updated_at, recorded_at, NOW());

ALTER TABLE habit_insights
  ALTER COLUMN updated_at SET DEFAULT NOW(),
  ALTER COLUMN updated_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_habit_insights_state
  ON habit_insights (owner, superseded, updated_at);
