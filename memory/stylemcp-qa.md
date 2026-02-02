# StyleMCP QA Report

**Date:** January 25, 2026  
**Version Tested:** 0.1.2 (npm), Live at stylemcp.com  
**Tester:** Automated QA Review

---

## 🔴 Overall Verdict: NOT READY TO PROMOTE

**Recommendation:** Fix critical issues before promotion. The core functionality works well, but the GitHub Action is completely broken and the test suite has significant failures.

---

## ✅ What Works

### CLI (Excellent)
- All commands functional: `validate`, `rewrite`, `test`, `packs`, `inspect`, `serve`
- Help output is clear and comprehensive
- Error handling works (missing text, invalid pack)
- Exit codes correct (0 for pass, 1 for fail)
- npm global install works: `npm install -g stylemcp@0.1.2`

### REST API (Excellent)
All endpoints at https://stylemcp.com/api/ working:

| Endpoint | Status | Notes |
|----------|--------|-------|
| `POST /api/validate` | ✅ | Returns detailed violations with positions |
| `POST /api/rewrite` | ✅ | All modes work (minimal, normal, aggressive) |
| `POST /api/validate/batch` | ✅ | Aggregates scores correctly |
| `GET /api/packs` | ✅ | Lists available packs |
| `GET /api/packs/{pack}` | ✅ | Returns pack metadata |
| `GET /api/packs/{pack}/voice` | ✅ | Full voice config |
| `GET /api/packs/{pack}/ctas` | ✅ | Complete CTA rules |
| `GET /health` | ✅ | Health check works |

### MCP Server (Excellent)
- Stdio transport works correctly
- All 8 tools register properly:
  - `validate_text`, `rewrite_to_style`, `get_voice_rules`
  - `get_copy_patterns`, `get_cta_rules`, `get_tokens`
  - `suggest_ctas`, `list_packs`
- Claude Desktop config documented correctly

### Landing Page (Good)
- No broken links
- All navigation functional (#features, #examples, /docs.html)
- API examples accurate
- Mobile-responsive design works
- Footer links work (/docs.html, /api/packs, /health)

### Documentation (Good)
- README is comprehensive
- /docs.html covers all endpoints
- Code examples work when copy-pasted
- MCP setup instructions clear

---

## 🔴 Critical Issues (Must Fix)

### 1. GitHub Action Build is Completely Broken

**Severity:** CRITICAL  
**Location:** `/action/src/index.ts`

The GitHub Action cannot be built:

```bash
$ cd action && npm install && npm run build
Error: [tsl] ERROR
  TS5110: Option 'module' must be set to 'NodeNext' when option 'moduleResolution' is set to 'NodeNext'.
  TS6059: File 'action/src/index.ts' is not under 'rootDir' '/src'.
  TS2459: Module '"../../src/validator/index.js"' declares 'ValidationResult' locally, but it is not exported.
  TS2459: Module '"../../src/validator/index.js"' declares 'Violation' locally, but it is not exported.
```

**Problems:**
1. Action imports from `../../src/validator/index.js` but `ValidationResult` and `Violation` types aren't exported (they're in schema/index.ts)
2. TypeScript config rootDir doesn't include the action folder
3. No `dist/` folder exists in `/action/`

**Fix Required:**
```typescript
// In action/src/index.ts, change:
import { validate, ValidationResult, Violation } from '../../src/validator/index.js';

// To:
import { validate } from '../../dist/validator/index.js';
import { ValidationResult, Violation } from '../../dist/schema/index.js';
```

Also need separate tsconfig for action or add action/tsconfig.json with proper settings.

---

### 2. Test Suite Failing (19/33 = 58% failure rate)

**Severity:** CRITICAL  
**Location:** Test expectations vs validator behavior

```bash
$ stylemcp test
Results:
  14 passed, 19 failed, 33 total
```

**Root Cause:** Tests expect certain inputs to FAIL validation, but they PASS because:
- `minScore` is 70, and many "bad" texts score above 70
- Only `error` severity blocks validation, not `warning` or `info`

**Examples:**
| Test | Input | Expected | Actual | Score |
|------|-------|----------|--------|-------|
| fail-cta-submit | "Submit" | FAIL | PASS | 90 |
| fail-cta-yes | "Yes" | FAIL | PASS | 80 |
| fail-excited-announcement | "We're excited to announce..." | FAIL | PASS | 97 |
| fail-oops | "Oops! Something went wrong 😅" | FAIL | PASS | 94 |

**Fix Options:**
1. Lower `minScore` in pack to 50-60
2. Elevate anti-pattern violations from `warning` to `error`
3. Update test expectations to match actual scoring behavior

---

### 3. Violation ID Collision (Global Counter)

**Severity:** HIGH  
**Location:** `src/validator/rules/voice.ts` and `src/validator/rules/cta.ts`

```typescript
// voice.ts
let violationId = 0;  // Module-level, persists across requests

// cta.ts  
let violationId = 1000;  // Starts at 1000 to avoid collision
```

In server context, these counters increment forever:
- First request: v-1, v-2, v-3...
- Second request: v-4, v-5, v-6...
- After 1000 requests from CTA rules, IDs could theoretically collide

**Fix:**
```typescript
// Pass counter into validate function or use UUID
import { randomUUID } from 'crypto';

function createViolation(...): Violation {
  return {
    id: `v-${randomUUID().slice(0, 8)}`,
    // ...
  };
}
```

---

## 🟡 Minor Issues (Can Fix Later)

### 4. No Rate Limiting on API

**Severity:** MEDIUM  
**Location:** `src/server/http.ts`

No rate limiting middleware. Public API could be abused.

**Recommended Fix:**
```typescript
import rateLimit from 'express-rate-limit';

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per window
});

app.use('/api/', limiter);
```

---

### 5. Pack Cache Never Invalidates

**Severity:** LOW  
**Location:** `src/server/http.ts`

```typescript
const packCache = new Map<string, Pack>();
// No TTL, no invalidation
```

If packs are updated on disk, server restart required.

**Recommendation:** Add TTL or file watcher for development.

---

### 6. Malformed JSON Returns HTML Error

**Severity:** LOW  
**Location:** Express error handling

```bash
$ curl -X POST https://stylemcp.com/api/validate -d 'not json'
<!DOCTYPE html>
<html><body><pre>Bad Request</pre></body></html>
```

Should return JSON: `{"error": "Invalid JSON"}`

**Fix:** Add JSON parse error middleware.

---

### 7. Version Mismatch

**Severity:** LOW  
**Location:** Multiple files

- `package.json`: 0.1.2
- CLI `--version`: 0.1.0
- Health endpoint: 0.1.0
- MCP server: 0.1.0

**Fix:** Use dynamic version from package.json:
```typescript
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { version } = require('../package.json');
```

---

## 🧪 Edge Cases Tested

| Test Case | Result | Notes |
|-----------|--------|-------|
| Empty string | ✅ | Returns "No text provided" error |
| Very long input (50k chars) | ✅ | Processes successfully |
| Special characters (émoji 🚀) | ✅ | Handles correctly |
| XSS attempt (`<script>`) | ✅ | Treated as text, no execution |
| Nonexistent pack | ✅ | Returns clear error with path |
| Missing required field | ✅ | Returns 400 with error message |

---

## 📋 Recommended Fix Priority

### Before Promotion (Blockers):
1. **Fix GitHub Action build** - Users literally can't use it
2. **Fix or update test expectations** - 58% failure rate looks bad
3. **Fix violation ID collision** - Real bug in production

### Soon After Promotion:
4. Add rate limiting
5. Fix version consistency
6. Return JSON for malformed input

### Nice to Have:
7. Pack cache invalidation
8. Better empty string error message

---

## 📁 Files to Modify

```
src/validator/rules/voice.ts     # Fix violation ID
src/validator/rules/cta.ts       # Fix violation ID  
src/server/http.ts               # Add rate limiting, fix JSON errors
src/cli/index.ts                 # Fix version
action/src/index.ts              # Fix imports
action/tsconfig.json             # Create with proper settings
packs/saas/manifest.yaml         # Consider lowering minScore
```

---

## ✨ What's Actually Excellent

Despite the issues, the core product is solid:

1. **Validation logic** is smart and catches real problems
2. **API design** is clean and RESTful
3. **MCP integration** is well-implemented
4. **Documentation** is better than most OSS projects
5. **Landing page** is professional
6. **CLI UX** is excellent with colors and clear output

The bones are good. Fix the blockers and this is ready to ship.
