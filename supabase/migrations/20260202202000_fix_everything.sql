-- Fix RLS policies for profiles table
DROP POLICY IF EXISTS "Users can view own profile" ON profiles;
DROP POLICY IF EXISTS "Users can update own profile" ON profiles;
DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

-- Recreate all policies
CREATE POLICY "Users can view own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Update get_usage_stats function with correct column names
CREATE OR REPLACE FUNCTION get_usage_stats(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  profile_record RECORD;
BEGIN
  SELECT * INTO profile_record FROM profiles WHERE id = p_user_id;
  
  IF NOT FOUND THEN
    RETURN json_build_object(
      'used', 0,
      'limit', 5000,
      'remaining', 5000,
      'reset_date', date_trunc('month', NOW()) + INTERVAL '1 month'
    );
  END IF;
  
  RETURN json_build_object(
    'used', COALESCE(profile_record.requests_this_month, 0),
    'limit', COALESCE(profile_record.monthly_request_limit, 5000),
    'remaining', GREATEST(0, COALESCE(profile_record.monthly_request_limit, 5000) - COALESCE(profile_record.requests_this_month, 0)),
    'reset_date', date_trunc('month', NOW()) + INTERVAL '1 month'
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
