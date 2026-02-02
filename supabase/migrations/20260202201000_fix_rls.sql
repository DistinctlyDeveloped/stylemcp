-- Fix RLS to allow users to insert their own profile
-- Drop existing policy if it exists and recreate with proper permissions

DROP POLICY IF EXISTS "Users can insert own profile" ON profiles;

-- Allow users to insert their own profile (id must match auth.uid())
CREATE POLICY "Users can insert own profile" ON profiles
  FOR INSERT WITH CHECK (auth.uid() = id);

-- Also create a service function to create profiles that bypasses RLS
CREATE OR REPLACE FUNCTION create_profile_for_user(
  p_user_id UUID,
  p_email TEXT
)
RETURNS JSON AS $$
DECLARE
  new_api_key TEXT;
  result RECORD;
BEGIN
  new_api_key := 'sk_live_' || encode(gen_random_bytes(24), 'hex');
  
  INSERT INTO profiles (id, email, api_key, tier, monthly_request_limit)
  VALUES (p_user_id, COALESCE(p_email, 'unknown'), new_api_key, 'free', 5000)
  ON CONFLICT (id) DO UPDATE SET updated_at = NOW()
  RETURNING * INTO result;
  
  RETURN row_to_json(result);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Grant execute to authenticated users
GRANT EXECUTE ON FUNCTION create_profile_for_user TO authenticated;
