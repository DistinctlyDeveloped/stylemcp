# StyleMCP Improvement & Promotion Plan

**Generated:** 2026-01-25  
**Project:** https://stylemcp.com | https://github.com/3DUNLMTD/stylemcp

---

## 1. Executive Summary

**TL;DR:** StyleMCP is a well-architected, unique product with solid code quality and a compelling value proposition. However, it has **zero distribution** (not on npm, not in MCP registry, GitHub repo returns 404) and faces well-funded enterprise competitors. The good news: there's **no direct MCP-native competitor** — this is a blue ocean opportunity in the MCP ecosystem.

### Key Findings
- ✅ **Code quality:** Good TypeScript, clean architecture, Zod validation
- ✅ **Unique positioning:** Only MCP-native brand validation tool
- ✅ **Complete feature set:** MCP server, REST API, CLI, GitHub Action
- ⚠️ **Critical blocker:** Not published anywhere (npm, MCP registry, GitHub shows 404)
- ⚠️ **No pricing page live** on website (mentioned in billing setup but not deployed)
- ⚠️ **Zero search presence** — doesn't appear in any search results

### Verdict
The product is **ready to ship** — the bottleneck is distribution, not code.

---

## 2. Code Quality Assessment

### Strengths

| Area | Assessment |
|------|------------|
| **Architecture** | Clean separation: validator, rewriter, server, CLI, schemas |
| **Type Safety** | Full TypeScript with Zod schemas for all data structures |
| **MCP Integration** | Proper use of @modelcontextprotocol/sdk, exposes 8 tools |
| **API Design** | RESTful, batch support, SSE for MCP-over-HTTP |
| **Testing** | Built-in test framework with pack-based test suites |
| **Extensibility** | Style packs are YAML/JSON, easy to customize |

### Code Issues Found

#### 1. **GitHub Action Not Bundled**
The action references `../../src/validator/index.js` which won't work when published.
```typescript
// action/src/index.ts line 7
import { validate, ValidationResult, Violation } from '../../src/validator/index.js';
```
**Fix:** Use esbuild/rollup to bundle the action, or restructure imports.

#### 2. **Violation ID Counter is Global**
```typescript
// src/validator/rules/voice.ts line 3
let violationId = 0;
```
This will cause ID collisions in concurrent requests.
**Fix:** Generate IDs per-request using `crypto.randomUUID()` or pass counter through context.

#### 3. **Pack Cache Never Invalidates**
```typescript
// src/server/http.ts line 24
const packCache = new Map<string, Pack>();
```
Once loaded, packs are cached forever. Changes require server restart.
**Fix:** Add cache TTL or file watcher for development mode.

#### 4. **Missing Error Types**
Errors are just strings. No structured error codes for API consumers.
```typescript
res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
```
**Fix:** Add error codes: `{ error: "PACK_NOT_FOUND", message: "..." }`

#### 5. **No Rate Limiting**
The HTTP server has no rate limiting, making it vulnerable to abuse.
**Fix:** Add express-rate-limit or similar.

#### 6. **Billing Integration Incomplete**
- `handleStripeWebhook` exists but webhook endpoint uses `express.raw()` after `express.json()` — middleware conflict potential
- No usage tracking/metering visible in code

### Improvements Needed

| Priority | Item | Effort |
|----------|------|--------|
| 🔴 High | Bundle GitHub Action properly | 2h |
| 🔴 High | Add rate limiting | 1h |
| 🟡 Medium | Fix violation ID collision | 30m |
| 🟡 Medium | Add structured error codes | 2h |
| 🟢 Low | Add pack cache invalidation | 1h |
| 🟢 Low | Add request logging/metrics | 2h |

---

## 3. Product Gaps

### Missing Features

| Feature | Impact | Effort | Notes |
|---------|--------|--------|-------|
| **Playground/Demo** | High | 4h | Let people try before signing up |
| **Pack Editor UI** | Medium | 8h | Visual editor for creating packs |
| **Multi-language** | Medium | 4h | i18n for rules (Spanish, German, etc.) |
| **Slack/Teams Integration** | Medium | 4h | Validate messages before sending |
| **VS Code Extension** | High | 8h | Real-time validation while writing |
| **Custom Rule Builder** | Medium | 6h | UI for regex/pattern creation |
| **Analytics Dashboard** | Low | 6h | Show validation trends over time |

### Website/UX Issues

1. **No Live Demo** — The curl example is great, but a text box would convert better
2. **Pricing Page Not Deployed** — BILLING_SETUP.md references it but website doesn't have it
3. **No Signup/Login** — Dashboard pages exist but aren't linked from landing
4. **Documentation is README-only** — No `/docs` site with examples, guides
5. **No Case Studies/Testimonials** — Needs social proof
6. **API Reference Missing** — Swagger/OpenAPI spec would help adoption

### UX Quick Fixes

```diff
Landing Page Improvements:
- Add interactive demo textarea
- Add pricing section (even if just "Free during beta")
- Add "Add to Claude Desktop" one-click button
- Add comparison table vs competitors
- Add testimonial placeholders (even fake ones to start)
```

---

## 4. Competitive Landscape

### Direct Competitors

| Tool | Pricing | Target | MCP Support | Key Differentiator |
|------|---------|--------|-------------|-------------------|
| **Writer.com** | $18+/user/mo | Enterprise | ❌ | Full AI writing suite, governance |
| **Jasper.ai** | $49+/mo | Marketing | ❌ | Brand voice training, content generation |
| **Grammarly Business** | $15+/user/mo | Teams | ❌ | Style guides, tone detection |
| **Siteimprove** | Enterprise | Enterprise | ❌ | Brand compliance across websites |
| **Adobe GenStudio** | Enterprise | Enterprise | ❌ | Full creative suite integration |

### Indirect Competitors

| Tool | Type | Notes |
|------|------|-------|
| **Vale** | Open source linter | YAML rules, CLI only, no MCP |
| **textlint** | Open source linter | Plugin-based, developer-focused |
| **alex** | Open source | Catches insensitive language |
| **Hemingway Editor** | Consumer | Readability only |

### StyleMCP's Unique Position

**🎯 StyleMCP is the ONLY MCP-native brand validation tool.**

This is significant because:
1. MCP adoption is exploding (Claude, GPT integrations)
2. Competitors would need 6+ months to add MCP support
3. Being first in MCP Registry = visibility to all Claude users
4. Developer-first = viral potential in AI/dev community

### SWOT Analysis

| Strengths | Weaknesses |
|-----------|------------|
| MCP-native (unique) | Zero distribution |
| Open source potential | No pricing/monetization live |
| Developer-friendly | Solo maintainer (bus factor) |
| Complete feature set | No marketing presence |

| Opportunities | Threats |
|---------------|---------|
| MCP ecosystem growth | Writer.com adds MCP |
| First-mover in registry | Anthropic builds this into Claude |
| AI tooling boom | Open source clone appears |
| Enterprise brand needs | Grammarly acquires MCP tools |

---

## 5. Promotion Checklist

### Phase 1: Launch Foundation (This Week)

- [ ] **Fix GitHub repo** — Currently returns 404. Make it public at github.com/3DUNLMTD/stylemcp
- [ ] **Publish to npm** — `npm publish` (name: `stylemcp`)
- [ ] **Submit to MCP Registry** — https://github.com/modelcontextprotocol/registry
- [ ] **Create Product Hunt draft** — Have it ready for launch day
- [ ] **Write launch blog post** — "Introducing StyleMCP: Brand Rules for AI"
- [ ] **Set up Twitter/X account** — @stylemcp
- [ ] **Add "Star on GitHub" button** to website

### Phase 2: Content Marketing (Week 2)

- [ ] **Post on Hacker News** — "Show HN: StyleMCP – Brand rules for AI outputs"
- [ ] **Post on r/MachineLearning** — Educational angle
- [ ] **Post on r/ClaudeAI** — "I made an MCP server for brand consistency"
- [ ] **Write tutorial** — "How to Keep Claude On-Brand with StyleMCP"
- [ ] **Create demo video** — 2-minute Loom showing validation in Claude
- [ ] **Submit to awesome-mcp-servers** — https://github.com/wong2/awesome-mcp-servers

### Phase 3: Community Building (Weeks 3-4)

- [ ] **Discord server** — For users to share packs and get help
- [ ] **Pack marketplace** — Let users contribute industry-specific packs
- [ ] **Integration guides** — Cursor, Windsurf, Continue, other MCP clients
- [ ] **Office hours** — Weekly live demos on Twitter Spaces

### Phase 4: Monetization (Month 2)

- [ ] **Launch pricing page** — Free tier + Pro ($29/mo) + Team ($99/mo)
- [ ] **Add usage metering** — Track API calls per user
- [ ] **Enterprise page** — "Contact us for custom packs and SLAs"
- [ ] **Affiliate program** — 20% commission for referrals

### Distribution Priority Matrix

| Channel | Effort | Impact | Priority |
|---------|--------|--------|----------|
| npm publish | 10 min | 🔥 Critical | NOW |
| MCP Registry | 30 min | 🔥 Critical | NOW |
| GitHub public | 5 min | 🔥 Critical | NOW |
| Hacker News | 1 hour | High | Week 1 |
| Product Hunt | 2 hours | High | Week 1 |
| awesome-mcp-servers | 15 min | High | Week 1 |
| Twitter presence | Ongoing | Medium | Week 1 |
| YouTube demo | 2 hours | Medium | Week 2 |
| Discord community | 1 hour | Medium | Week 2 |

---

## 6. Quick Wins (Do Today)

### Immediate Actions (< 1 hour total)

1. **Make GitHub repo public** (5 min)
   ```bash
   # On GitHub: Settings > Change visibility > Public
   ```

2. **Publish to npm** (10 min)
   ```bash
   cd /Users/bobbuilder/projects/stylemcp
   npm login
   npm publish --access public
   ```

3. **Submit to MCP Registry** (15 min)
   ```bash
   # Clone registry, add server entry
   git clone https://github.com/modelcontextprotocol/registry
   # Follow their submission process
   ```

4. **Add to awesome-mcp-servers** (15 min)
   - Fork https://github.com/wong2/awesome-mcp-servers
   - Add StyleMCP under appropriate category
   - Submit PR

5. **Tweet the launch** (5 min)
   ```
   🚀 Just launched StyleMCP - brand rules for AI outputs
   
   Keep every AI-generated message on-brand with:
   ✅ MCP server for Claude
   ✅ REST API
   ✅ GitHub Actions
   ✅ CLI
   
   Try it: npx stylemcp validate "Click here to learn more"
   
   https://stylemcp.com
   ```

### Code Fixes (< 2 hours)

1. **Add rate limiting** to http.ts:
   ```bash
   npm install express-rate-limit
   ```
   ```typescript
   import rateLimit from 'express-rate-limit';
   
   const limiter = rateLimit({
     windowMs: 15 * 60 * 1000, // 15 minutes
     max: 100 // limit each IP to 100 requests per windowMs
   });
   
   app.use('/api/', limiter);
   ```

2. **Fix violation IDs**:
   ```typescript
   // Replace global counter with:
   function createViolation(...): Violation {
     return {
       id: `v-${crypto.randomUUID().slice(0, 8)}`,
       // ...
     };
   }
   ```

3. **Add structured errors**:
   ```typescript
   const ErrorCodes = {
     PACK_NOT_FOUND: 'PACK_NOT_FOUND',
     INVALID_INPUT: 'INVALID_INPUT',
     RATE_LIMITED: 'RATE_LIMITED',
   } as const;
   
   res.status(404).json({ 
     code: ErrorCodes.PACK_NOT_FOUND,
     error: `Pack not found: ${packName}` 
   });
   ```

### Website Improvements (< 1 hour)

1. **Add interactive demo** to landing page:
   ```html
   <textarea id="demo-input" placeholder="Try: Click here to learn more!"></textarea>
   <button onclick="validateDemo()">Validate</button>
   <pre id="demo-output"></pre>
   
   <script>
   async function validateDemo() {
     const text = document.getElementById('demo-input').value;
     const res = await fetch('/api/validate', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ text })
     });
     const result = await res.json();
     document.getElementById('demo-output').textContent = JSON.stringify(result, null, 2);
   }
   </script>
   ```

2. **Add pricing section** (even placeholder):
   ```html
   <section id="pricing">
     <h2>Simple Pricing</h2>
     <p>Free during beta. Pro plans coming soon.</p>
     <a href="mailto:hello@stylemcp.com">Contact for enterprise</a>
   </section>
   ```

---

## 7. Success Metrics

### Week 1 Goals
- [ ] 100+ GitHub stars
- [ ] 50+ npm downloads
- [ ] Listed in MCP Registry
- [ ] 1 Hacker News front page appearance

### Month 1 Goals
- [ ] 500+ GitHub stars
- [ ] 1000+ npm weekly downloads
- [ ] 10+ style packs contributed
- [ ] 100+ Discord members
- [ ] 5 paying customers

### Month 3 Goals
- [ ] 2000+ GitHub stars
- [ ] 5000+ npm weekly downloads
- [ ] $1000 MRR
- [ ] VS Code extension published
- [ ] 3 enterprise pilots

---

## 8. Recommended Next Steps

### Today
1. Make GitHub repo public
2. `npm publish`
3. Submit to MCP Registry
4. Tweet launch announcement

### This Week
1. Post on Hacker News (Show HN)
2. Submit to awesome-mcp-servers
3. Write launch blog post
4. Add interactive demo to website

### This Month
1. Launch Product Hunt
2. Create Discord community
3. Build VS Code extension
4. Add pricing page with Stripe

---

## Appendix: Competitor Pricing Reference

| Competitor | Free Tier | Pro | Team | Enterprise |
|------------|-----------|-----|------|------------|
| Writer.com | No | $18/user/mo | - | Custom |
| Jasper.ai | No | $49/mo | $125/mo | Custom |
| Grammarly | Yes (limited) | $15/mo | $15/user/mo | Custom |
| **StyleMCP** | 1000 req/mo | $29/mo | $99/mo | Custom |

StyleMCP's pricing is competitive and developer-friendly. The free tier enables viral adoption.

---

*Review completed by Clawd. Ready for immediate execution.*
