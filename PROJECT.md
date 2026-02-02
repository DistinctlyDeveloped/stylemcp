# StyleMCP

**Telegram Group ID:** -5160071144  
**Repo:** ~/Projects/stylemcp (GitHub: 3DUNLMTD/stylemcp)  
**Live:** https://stylemcp.com  
**Twitter:** @style_mcp  

## Overview

MCP server + REST API for brand voice validation and enforcement. Validates text against style packs (tone, vocabulary, patterns) and can rewrite violations automatically.

**Target Users:** Content teams, marketers, developers integrating brand voice into workflows

**Tech Stack:**
- TypeScript MCP server
- REST API
- Claude 3.5 Haiku (AI rewrites)
- YAML-based style packs

## Pricing

- **Free:** 5,000 req/mo
- **Pro:** $9/mo (25k req, AI rewrites)
- **Team:** $29/mo (100k req)

## Current Status

**What's Working:**
- ✅ REST API (validate, rewrite, packs)
- ✅ MCP server
- ✅ 8 industry packs (SaaS, Healthcare, Finance, E-commerce, Legal, Real Estate, Education, Government)
- ✅ Landing page with live demo
- ✅ GitHub Action for CI/CD

**What's Not:**
- Auth system not implemented (OAuth buttons hidden)
- No user dashboard yet
- Twitter @style_mcp has 0 followers

## Open Issues

- ALL CAPS regex in legal pack triggers incorrectly
- Chrome extension needs icons before Web Store submission

## Next Steps

1. Chrome extension icons → Web Store submission
2. VS Code extension
3. User auth + dashboard
4. "Learn my voice" feature
