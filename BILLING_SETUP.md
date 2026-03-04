# StyleMCP Billing Setup Guide

This guide walks you through setting up the full billing system with Supabase (auth + database) and Stripe (payments).

## Overview

- **Supabase**: User accounts, API keys, usage tracking
- **Stripe**: Subscription billing, checkout, customer portal

## Step 1: Create Supabase Project

1. Go to [supabase.com](https://supabase.com) and create a new project
2. Note your project credentials:
   - **Project URL**: `https://db-stylemcp.distinctlydeveloped.com`
   - **Anon Key**: `eyJhbGc...` (public, safe for frontend)
   - **Service Role Key**: `eyJhbGc...` (private, backend only)

## Step 2: Run Database Migrations

1. Go to your Supabase dashboard → SQL Editor
2. Copy the contents of `supabase/migrations/001_create_tables.sql`
3. Run the SQL to create all tables and functions

## Step 3: Enable OAuth Providers (Optional)

1. Go to Authentication → Providers
2. Enable Google OAuth:
   - Create OAuth credentials at [console.cloud.google.com](https://console.cloud.google.com)
   - Add `https://db-stylemcp.distinctlydeveloped.com/auth/v1/callback` as redirect URI
3. Enable GitHub OAuth:
   - Create OAuth app at [github.com/settings/developers](https://github.com/settings/developers)
   - Add same callback URL

## Step 4: Create Stripe Account

1. Go to [stripe.com](https://stripe.com) and create an account
2. Get your API keys from Dashboard → Developers → API keys:
   - **Publishable Key**: `pk_live_...` or `pk_test_...`
   - **Secret Key**: `sk_live_...` or `sk_test_...`

## Step 5: Create Stripe Webhook

1. Go to Dashboard → Developers → Webhooks
2. Add endpoint: `https://stylemcp.com/api/webhook/stripe`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Note the **Webhook Signing Secret**: `whsec_...`

## Step 6: Update Environment Variables

Add these to your `.env` file on the VPS:

```bash
# Supabase
SUPABASE_URL=https://db-stylemcp.distinctlydeveloped.com
SUPABASE_SERVICE_KEY=eyJhbGc...

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Legacy (optional, for backwards compatibility)
STYLEMCP_API_KEY=your-legacy-key
```

## Step 7: Update Frontend Configuration

In these files, replace the placeholder values:
- `landing/login.html`
- `landing/signup.html`
- `landing/dashboard.html`

Find and replace:
```javascript
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_ANON_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

With your actual values:
```javascript
const SUPABASE_URL = 'https://db-stylemcp.distinctlydeveloped.com';
const SUPABASE_ANON_KEY = 'eyJhbGc...';
```

## Step 8: Deploy Updates

On your Mac:
```bash
cd ~/Desktop/stylemcp
npm install
npm run build
```

Then copy to VPS:
```bash
scp -r dist root@82.180.163.60:/opt/stylemcp/
scp -r landing root@82.180.163.60:/var/www/stylemcp/
scp .env root@82.180.163.60:/opt/stylemcp/
```

On VPS:
```bash
cd /opt/stylemcp
docker compose down
docker compose up -d --build
```

## Step 9: Test the Flow

1. Visit `https://stylemcp.com/signup.html`
2. Create an account
3. Check your email for confirmation
4. Log in and view your dashboard
5. Your API key should be visible

## File Structure

```
stylemcp/
├── src/server/
│   ├── billing.ts          # Stripe + Supabase integration
│   └── middleware/
│       └── auth.ts          # API key validation
├── supabase/migrations/
│   └── 001_create_tables.sql
├── landing/
│   ├── index.html           # Landing page
│   ├── docs.html            # Documentation
│   ├── pricing.html         # Pricing page
│   ├── login.html           # Login page
│   ├── signup.html          # Signup page
│   └── dashboard.html       # User dashboard
└── .env                     # Environment variables
```

## Pricing Tiers

| Tier | Monthly Price | Requests/Month | AI Rewrites |
|------|---------------|----------------|-------------|
| Free | $0 | 5,000 | ❌ Basic only |
| Pro | $9 | 25,000 | ✅ Included |
| Team | $29 | 100,000 | ✅ Included |
| Enterprise | Custom | Unlimited | ✅ + Self-host |

### Stripe Product IDs (update in billing.ts)
- Pro: `price_pro_monthly` → $9/mo, 25,000 requests
- Team: `price_team_monthly` → $29/mo, 100,000 requests

## Troubleshooting

### "Invalid API key" errors
- Check that the API key exists in the `profiles` table
- Ensure `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` are set correctly

### Stripe webhook not working
- Check the webhook secret matches
- Verify the endpoint URL is correct
- Check Stripe dashboard for failed webhook attempts

### OAuth not redirecting
- Verify callback URLs in Google/GitHub match Supabase exactly
- Check browser console for errors
