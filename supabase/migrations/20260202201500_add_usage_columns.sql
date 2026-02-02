-- Add missing columns for usage tracking
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS requests_this_month INTEGER DEFAULT 0;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS billing_cycle_start TIMESTAMPTZ DEFAULT date_trunc('month', NOW());
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
