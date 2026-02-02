-- Fix the handle_new_user trigger to handle OAuth users better
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, api_key, tier, monthly_request_limit)
  VALUES (
    NEW.id,
    COALESCE(NEW.email, NEW.raw_user_meta_data->>'email', 'unknown@' || NEW.id::text),
    'sk_live_' || encode(gen_random_bytes(24), 'hex'),
    'free',
    5000
  )
  ON CONFLICT (id) DO NOTHING;  -- Skip if profile already exists
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Log the error but don't fail the user creation
  RAISE WARNING 'Failed to create profile for user %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
