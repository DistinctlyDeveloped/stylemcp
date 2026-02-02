import { createClient, SupabaseClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

// Environment variables (set these in .env)
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

// Initialize clients
let supabase: SupabaseClient | null = null;
let stripe: Stripe | null = null;

export function getSupabase(): SupabaseClient | null {
  if (!supabase && SUPABASE_URL && SUPABASE_SERVICE_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  }
  return supabase;
}

export function getStripe(): Stripe | null {
  if (!stripe && STRIPE_SECRET_KEY) {
    stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  }
  return stripe;
}

// Tier configuration
export const TIERS = {
  free: { limit: 5000, price: 0, aiRewrites: false },
  pro: { limit: 25000, price: 900, aiRewrites: true }, // $9.00 in cents
  team: { limit: 100000, price: 2900, aiRewrites: true }, // $29.00 in cents
  business: { limit: 500000, price: 9900, aiRewrites: true }, // $99.00 in cents
  enterprise: { limit: Infinity, price: null, aiRewrites: true }, // Custom pricing
} as const;

// Check if tier has AI rewrite access
export function tierHasAIAccess(tier: Tier): boolean {
  return TIERS[tier]?.aiRewrites ?? false;
}

export type Tier = keyof typeof TIERS;

// User profile from database
export interface UserProfile {
  id: string;
  email: string;
  tier: Tier;
  api_key: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  monthly_request_limit: number;
}

// Usage stats
export interface UsageStats {
  tier: Tier;
  limit: number;
  used: number;
  remaining: number;
  reset_date: string;
}

// Validate API key and get user profile
export async function validateApiKey(apiKey: string): Promise<UserProfile | null> {
  const db = getSupabase();
  if (!db) return null;

  const { data, error } = await db
    .from('profiles')
    .select('*')
    .eq('api_key', apiKey)
    .single();

  if (error || !data) return null;
  return data as UserProfile;
}

// Check if user has remaining quota
export async function checkQuota(userId: string): Promise<{ allowed: boolean; stats: UsageStats }> {
  const db = getSupabase();
  if (!db) {
    return {
      allowed: true,
      stats: { tier: 'free', limit: 1000, used: 0, remaining: 1000, reset_date: '' }
    };
  }

  const { data, error } = await db.rpc('get_usage_stats', { p_user_id: userId });

  if (error) {
    console.error('Error checking quota:', error);
    return {
      allowed: true,
      stats: { tier: 'free', limit: 1000, used: 0, remaining: 1000, reset_date: '' }
    };
  }

  const stats = data as UsageStats;
  return {
    allowed: stats.remaining > 0,
    stats,
  };
}

// Record API usage
export async function recordUsage(
  userId: string,
  endpoint: string,
  method: string,
  statusCode: number,
  responseTimeMs: number
): Promise<boolean> {
  const db = getSupabase();
  if (!db) return true;

  const { data, error } = await db.rpc('increment_usage', {
    p_user_id: userId,
    p_endpoint: endpoint,
    p_method: method,
    p_status: statusCode,
    p_time_ms: responseTimeMs,
  });

  if (error) {
    console.error('Error recording usage:', error);
    return true; // Don't block on logging errors
  }

  return data as boolean;
}

// Create Stripe checkout session
export async function createCheckoutSession(
  userId: string,
  tier: 'pro' | 'team',
  successUrl: string,
  cancelUrl: string
): Promise<string | null> {
  const stripeClient = getStripe();
  const db = getSupabase();
  if (!stripeClient || !db) return null;

  // Get or create Stripe customer
  const { data: profile } = await db
    .from('profiles')
    .select('email, stripe_customer_id')
    .eq('id', userId)
    .single();

  if (!profile) return null;

  let customerId = profile.stripe_customer_id;

  if (!customerId) {
    const customer = await stripeClient.customers.create({
      email: profile.email,
      metadata: { user_id: userId },
    });
    customerId = customer.id;

    await db
      .from('profiles')
      .update({ stripe_customer_id: customerId })
      .eq('id', userId);
  }

  // Create checkout session
  const session = await stripeClient.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    payment_method_types: ['card'],
    line_items: [
      {
        price_data: {
          currency: 'usd',
          product_data: {
            name: `StyleMCP ${tier.charAt(0).toUpperCase() + tier.slice(1)}`,
            description: `${TIERS[tier].limit.toLocaleString()} API requests/month`,
          },
          unit_amount: TIERS[tier].price!,
          recurring: { interval: 'month' },
        },
        quantity: 1,
      },
    ],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { user_id: userId, tier },
  });

  return session.url;
}

// Handle Stripe webhook
export async function handleStripeWebhook(
  payload: string | Buffer,
  signature: string
): Promise<{ success: boolean; error?: string }> {
  const stripeClient = getStripe();
  const db = getSupabase();
  if (!stripeClient || !db || !STRIPE_WEBHOOK_SECRET) {
    return { success: false, error: 'Stripe not configured' };
  }

  let event: Stripe.Event;

  try {
    event = stripeClient.webhooks.constructEvent(payload, signature, STRIPE_WEBHOOK_SECRET);
  } catch {
    return { success: false, error: `Webhook signature verification failed` };
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id;
      const tier = session.metadata?.tier as Tier;

      if (userId && tier) {
        await db
          .from('profiles')
          .update({
            tier,
            stripe_subscription_id: session.subscription as string,
            monthly_request_limit: TIERS[tier].limit,
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId);
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription;

      await db
        .from('profiles')
        .update({
          tier: 'free',
          stripe_subscription_id: null,
          monthly_request_limit: TIERS.free.limit,
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_subscription_id', subscription.id);
      break;
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription;

      // Handle plan changes, cancellation at period end, etc.
      if (subscription.cancel_at_period_end) {
        // Subscription will cancel at end of period - could notify user
        console.log('Subscription will cancel:', subscription.id);
      }
      break;
    }
  }

  return { success: true };
}

// Create customer portal session for managing subscription
export async function createPortalSession(
  userId: string,
  returnUrl: string
): Promise<string | null> {
  const stripeClient = getStripe();
  const db = getSupabase();
  if (!stripeClient || !db) return null;

  const { data: profile } = await db
    .from('profiles')
    .select('stripe_customer_id')
    .eq('id', userId)
    .single();

  if (!profile?.stripe_customer_id) return null;

  const session = await stripeClient.billingPortal.sessions.create({
    customer: profile.stripe_customer_id,
    return_url: returnUrl,
  });

  return session.url;
}

// Check if billing is configured
export function isBillingEnabled(): boolean {
  return !!(SUPABASE_URL && SUPABASE_SERVICE_KEY && STRIPE_SECRET_KEY);
}
