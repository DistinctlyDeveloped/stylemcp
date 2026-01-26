# StyleMCP Social Media Posts

## Twitter/X Launch Thread

### Tweet 1 (Main)
```
🚀 Introducing StyleMCP - Brand rules for AI outputs

Keep every AI-generated message on-brand with:
✅ Real-time validation
✅ Auto-rewriting
✅ Style packs (voice, vocabulary, CTAs)
✅ MCP + REST API + CLI + GitHub Action

Open source & free to use 👇

https://stylemcp.com
```

### Tweet 2 (Problem)
```
The problem: AI writes great content, but it doesn't know YOUR brand voice.

"Click here to learn more!" ❌
"Explore our features" ✅

StyleMCP catches these issues automatically and suggests fixes.
```

### Tweet 3 (How it works)
```
How it works:

1️⃣ Define your brand rules in YAML (voice, forbidden words, CTAs)
2️⃣ Validate text → get a score + violations
3️⃣ Auto-rewrite off-brand content

Works with Claude, GPT, or any AI via MCP protocol.
```

### Tweet 4 (Demo)
```
curl -X POST https://stylemcp.com/api/validate \
  -d '{"text": "Click here to learn more!"}'

Response:
{
  "valid": false,
  "score": 65,
  "violations": ["Avoid 'click here'"],
  "suggestion": "Learn more about our features"
}
```

### Tweet 5 (CTA)
```
Get started in 30 seconds:

npm install -g stylemcp
stylemcp validate "Your AI-generated copy"

GitHub: github.com/3DUNLMTD/stylemcp
Docs: stylemcp.com/docs.html

MIT licensed. PRs welcome! 🦞
```

---

## LinkedIn Post

```
🎯 Launching StyleMCP - Brand CI for AI Outputs

As AI generates more of our content, keeping it on-brand becomes critical.

StyleMCP solves this with:

📝 Style Packs - Define your voice, vocabulary, and forbidden patterns in YAML
✅ Real-time Validation - Score any text against your brand rules (0-100)
✏️ Auto-Rewriting - Automatically fix off-brand content
🔌 Flexible Integration - REST API, MCP Server, CLI, or GitHub Action

Use cases:
• Marketing teams ensuring AI copy matches brand guidelines
• Support teams validating chatbot responses
• Dev teams adding brand checks to CI/CD pipelines
• Anyone using Claude/GPT who wants consistent output

The best part? It's open source and free to self-host.

Try it: https://stylemcp.com
GitHub: https://github.com/3DUNLMTD/stylemcp

#AI #MarTech #BrandConsistency #OpenSource #MCP
```

---

## Reddit Post (r/mcp, r/ClaudeAI, r/ChatGPT)

**Title:** StyleMCP - Keep AI outputs on-brand with executable style rules

**Body:**
```
Hey everyone! Just launched StyleMCP - an open-source tool for enforcing brand consistency in AI-generated content.

**What it does:**
- Validates text against your brand rules (vocabulary, tone, CTAs)
- Scores content 0-100 based on guideline compliance  
- Auto-rewrites off-brand content
- Catches things like "click here", corporate jargon, forbidden words

**How to use:**
- REST API at stylemcp.com
- MCP Server for Claude Desktop / other MCP clients
- CLI for terminal or CI/CD
- GitHub Action for PR checks

**Quick start:**
```
npm install -g stylemcp
stylemcp validate "Your text here"
```

**MCP config:**
```json
{
  "mcpServers": {
    "stylemcp": {
      "command": "npx",
      "args": ["stylemcp"]
    }
  }
}
```

MIT licensed, self-hostable, and PRs welcome!

Links:
- Website: https://stylemcp.com
- GitHub: https://github.com/3DUNLMTD/stylemcp
- npm: https://www.npmjs.com/package/stylemcp

Would love feedback from the community!
```

---

## Hacker News Post

**Title:** Show HN: StyleMCP – Brand rules enforcement for AI outputs (MCP server)

**Text:**
```
StyleMCP validates and rewrites AI-generated text to match your brand voice.

The problem: AI models don't know your brand guidelines. They'll write "click here to learn more" when your style guide says to describe destinations. They'll use "utilize" when you prefer "use".

StyleMCP solves this with:
- Style packs: YAML files defining voice, vocabulary, forbidden patterns
- Validation API: Score text 0-100 against your rules
- Auto-rewriting: Fix violations automatically
- Multiple interfaces: REST API, MCP server, CLI, GitHub Action

Works with any AI via the Model Context Protocol (MCP) - so Claude, GPT, etc. can use your brand rules as context.

Self-hostable, MIT licensed.

https://stylemcp.com
https://github.com/3DUNLMTD/stylemcp
```

---

## Product Hunt Tagline & Description

**Tagline:** Brand rules for AI outputs - keep every message on-brand

**Description:**
```
StyleMCP validates and rewrites AI-generated text to match your brand voice.

🎯 Define brand rules in YAML (voice, vocabulary, forbidden words, CTAs)
✅ Validate any text and get a brand compliance score
✏️ Auto-rewrite off-brand content
🔌 Use via REST API, MCP Server, CLI, or GitHub Action

Perfect for:
- Marketing teams using AI for copy
- Support teams with AI chatbots
- Developers adding brand checks to CI/CD
- Anyone who wants consistent AI output

Open source, self-hostable, MIT licensed.
```
