# Review Report

## Summary of issues found
- Contextual CTA rules matched when context fields were missing, causing false-positive violations.
- MCP tool handlers and HTTP batch/tool endpoints accepted missing or non-string text, leading to runtime errors in validators/rewriters.
- GitHub webhook signature validation could throw on length mismatch when using timing-safe comparison.
- Billing client getters returned non-null types while possibly returning null at runtime.
- Unused import in HTTP server module.

## List of fixes made
- Fixed contextual CTA matching to require an actual context type/component before matching. (src/validator/rules/cta.ts)
- Added input validation guards for MCP tool calls to require text/context strings. (src/server/index.ts)
- Added per-item validation for batch validation and tool-call text validation for HTTP MCP endpoint. (src/server/http.ts)
- Hardened GitHub webhook signature verification to avoid timingSafeEqual length mismatch crashes. (src/server/http.ts)
- Updated billing client getters to return nullable types and removed an unused import. (src/server/billing.ts, src/server/http.ts)

## Issues needing owner input
- Decide whether the HTTP server should use the billing-aware auth/usage middleware in `src/server/middleware/auth.ts` (currently not wired) instead of the simple API key middleware.
- Confirm Supabase RPC functions `get_usage_stats` and `increment_usage` exist and match expected inputs/outputs; this can’t be validated locally without DB access.
- Confirm correct public base URL handling for checkout/portal URLs behind proxies (may need `app.set('trust proxy', ...)` or a configured base URL).
