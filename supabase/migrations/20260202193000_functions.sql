-- Just update the functions (table and policies already exist)

-- Auto-create profile on signup (trigger)
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, api_key)
  VALUES (
    NEW.id,
    NEW.email,
    'sk_live_' || encode(gen_random_bytes(24), 'hex')
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Usage stats RPC function
CREATE OR REPLACE FUNCTION get_usage_stats(p_user_id UUID)
RETURNS JSON AS $$
DECLARE
  profile_record RECORD;
  reset_date DATE;
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
  
  reset_date := date_trunc('month', NOW()) + INTERVAL '1 month';
  
  RETURN json_build_object(
    'used', COALESCE(profile_record.requests_this_month, 0),
    'limit', profile_record.monthly_request_limit,
    'remaining', GREATEST(0, profile_record.monthly_request_limit - COALESCE(profile_record.requests_this_month, 0)),
    'reset_date', reset_date
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to increment usage (call from API)
CREATE OR REPLACE FUNCTION increment_usage(p_api_key TEXT)
RETURNS BOOLEAN AS $$
DECLARE
  profile_record RECORD;
BEGIN
  SELECT * INTO profile_record FROM profiles WHERE api_key = p_api_key;
  
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  
  -- Reset counter if new billing cycle
  IF profile_record.billing_cycle_start < date_trunc('month', NOW()) THEN
    UPDATE profiles 
    SET requests_this_month = 1,
        billing_cycle_start = date_trunc('month', NOW()),
        updated_at = NOW()
    WHERE id = profile_record.id;
  ELSE
    UPDATE profiles 
    SET requests_this_month = requests_this_month + 1,
        updated_at = NOW()
    WHERE id = profile_record.id;
  END IF;
  
  RETURN TRUE;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Index for API key lookups (if not exists)
CREATE INDEX IF NOT EXISTS idx_profiles_api_key ON profiles(api_key);
