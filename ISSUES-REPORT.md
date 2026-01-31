# StyleMCP Codebase Scan Report

Date: 2026-01-31

## 1. Critical issues (must fix)

1) **Path traversal risk when selecting packs (server + MCP).**
- **Why it matters:** `pack` is user-controlled and is joined directly to the packs directory. A malicious value like `../` can escape the intended directory and cause arbitrary file reads via `manifest.yaml` and subsequent pack files.
- **Where:**
  - `src/server/http.ts:97-105` (in `getPack`)
  - `src/server/index.ts:24-38` (in `ensurePack`)
- **Fix:** Validate `packName` against a whitelist (e.g., `listAvailablePacks()`) or reject any path with `..`, `/`, `\`, or path separators; resolve and ensure it stays within `getPacksDirectory()`.

2) **Billing endpoints rely on a shared API key and accept arbitrary `userId`.**
- **Why it matters:** Anyone with the shared API key can create checkout or portal sessions for any user ID, enabling account hijack or billing abuse.
- **Where:**
  - `src/server/http.ts:503-586` (`/api/checkout`, `/api/billing/portal`)
- **Fix:** Require authenticated user identity (e.g., JWT/session) and enforce `userId` matches the authenticated subject. Avoid a single global API key for user-specific billing operations.

## 2. Important issues (should fix)

1) **Pack load errors are silently ignored in HTTP server cache path.**
- **Why it matters:** `loadPack` returns `errors` but the HTTP server never logs or returns them; clients can get partial/default pack data without notice.
- **Where:** `src/server/http.ts:97-105` (no handling of `result.errors`)
- **Fix:** Log `result.errors`, return a warning in responses, or fail the request when pack data is incomplete.

2) **No timeout or abort handling for AI rewrite requests.**
- **Why it matters:** A hung upstream call can tie up the Node event loop and hold connections open indefinitely.
- **Where:** `src/rewriter/ai-rewriter.ts:138-154`
- **Fix:** Use `AbortController` with a reasonable timeout and handle timeout errors explicitly.

3) **CORS is fully open for all routes by default.**
- **Why it matters:** If you later add cookie/session auth, open CORS becomes a CSRF-like risk and exposes APIs to any origin.
- **Where:** `src/server/http.ts:90-92`
- **Fix:** Restrict origins or configure per-environment allowed origins.

4) **In-memory rate limiter is bypassable and non-durable.**
- **Why it matters:** Restart clears limits; multi-instance deployments allow easy bypass; `x-forwarded-for` handling is not validated.
- **Where:** `src/server/http.ts:129-155`
- **Fix:** Use a shared store (Redis) and trusted proxy configuration; or rely on gateway-level rate limiting.

5) **`validate` option in pack loader is unused.**
- **Why it matters:** Dead configuration paths make behavior confusing and can hide validation-related bugs.
- **Where:** `src/utils/pack-loader.ts:43-45`
- **Fix:** Remove the option or implement schema validation toggling.

## 3. Minor issues (nice to fix)

1) **Repeated logic in MCP server and HTTP server tool routing.**
- **Why it matters:** Increases maintenance burden and the risk of behavior drift.
- **Where:** `src/server/index.ts` and `src/server/http.ts` (tool handlers)
- **Fix:** Extract shared handlers or route calls through a common module.

2) **Webhook processing doesn’t validate GitHub event type or action schema beyond basic checks.**
- **Why it matters:** Unexpected payloads could cause runtime errors if the JSON schema changes or is malformed.
- **Where:** `src/server/http.ts:70-86`
- **Fix:** Validate payload structure before accessing nested fields.

3) **Pack tests exist but are not integrated into automated testing.**
- **Why it matters:** Changes can regress rule behavior without any CI signal.
- **Where:** `src/cli/index.ts` (pack tests only run via CLI)
- **Fix:** Add a test runner that executes pack tests during CI.

## 4. Recommendations

- Add a centralized pack-name validator and use it in CLI, MCP, and HTTP server paths.
- Introduce a proper authentication layer (JWT/session) for user-specific billing endpoints.
- Add request/response timeouts and error metrics for external API calls.
- Add structured logging and surface pack load warnings to clients or dashboards.
- Establish a baseline test suite (unit + pack tests) and wire it into CI.

