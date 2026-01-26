# StyleMCP

Executable brand rules for AI models and agents. Keep every AI-generated message on-brand.

## What is StyleMCP?

StyleMCP validates and rewrites AI-generated text to match your brand voice. Use it as:

- **REST API** - Validate text from any application
- **MCP Server** - Direct integration with Claude and other AI agents
- **CLI** - Check copy in your terminal or CI/CD
- **GitHub Action** - Catch off-brand copy in pull requests

## Quick Start

### API

```bash
curl -X POST https://stylemcp.com/api/validate \
  -H "Content-Type: application/json" \
  -d '{"text": "Click here to learn more!"}'
```

Response:

```json
{
  "valid": false,
  "score": 65,
  "violations": [
    {
      "rule": "no-click-here",
      "severity": "error",
      "message": "Avoid 'click here' - describe the destination instead",
      "suggestion": "Learn more about our features"
    }
  ]
}
```

### CLI

```bash
# Install
npm install -g stylemcp

# Validate text
stylemcp validate "Click here to learn more"

# Validate file
stylemcp validate src/copy/homepage.json --pack saas

# Rewrite text
stylemcp rewrite "Please utilize our product" --mode aggressive
```

### MCP (Claude Desktop)

Add to your `claude_desktop_config.json`:

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

Now Claude can validate and rewrite text using your brand rules.

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/validate` | Validate text against brand rules |
| POST | `/api/rewrite` | Rewrite text to match brand voice |
| POST | `/api/validate/batch` | Validate multiple texts |
| GET | `/api/packs` | List available style packs |
| GET | `/api/packs/{pack}/voice` | Get voice guidelines |
| GET | `/api/packs/{pack}/ctas` | Get CTA rules |
| GET | `/api/mcp/sse` | MCP SSE endpoint |
| POST | `/api/mcp/call` | MCP tool calls |

## Style Packs

StyleMCP uses **style packs** - YAML files that define your brand rules.

### Default Pack: `saas`

The included `saas` pack is designed for B2B SaaS products:

- **Vocabulary**: Prefer "use" over "utilize", "help" over "assist"
- **Forbidden words**: "synergy", "leverage", "cutting-edge", "game-changing"
- **Patterns to avoid**: "click here", "we're sorry for any inconvenience"
- **CTA rules**: Avoid "Submit", "Click here", "OK" - prefer "Save", "Create", "Sign up"

### Pack Structure

```
packs/
  my-brand/
    manifest.yaml      # Pack metadata
    voice.yaml         # Tone, vocabulary, forbidden words
    copy_patterns.yaml # Reusable copy templates
    cta_rules.yaml     # Button/CTA guidelines
    tokens.json        # Design tokens (optional)
```

### Create Your Own Pack

```bash
# Copy the default pack
cp -r packs/saas packs/my-brand

# Edit the rules
nano packs/my-brand/voice.yaml

# Use your pack
curl -X POST https://stylemcp.com/api/validate \
  -d '{"text": "Your text", "pack": "my-brand"}'
```

### voice.yaml Example

```yaml
tone:
  summary: "Friendly, clear, and helpful"
  attributes:
    - name: friendly
      weight: 0.8
    - name: professional
      weight: 0.7

vocabulary:
  rules:
    - preferred: "use"
      avoid: ["utilize", "leverage"]
    - preferred: "help"
      avoid: ["assist", "facilitate"]

  forbidden:
    - "synergy"
    - "paradigm shift"
    - "game-changing"

doNot:
  - pattern: "click here"
    reason: "Poor accessibility"
    suggestion: "Describe the destination"
    severity: error

  - pattern: "\\b(obviously|simply|just)\\b"
    isRegex: true
    reason: "Can make users feel stupid"
    severity: warning
```

## Self-Hosting

### Docker

```bash
# Clone the repo
git clone https://github.com/stylemcp/stylemcp.git
cd stylemcp

# Set up environment
echo "STYLEMCP_API_KEY=$(openssl rand -hex 32)" > .env

# Run with Docker
docker compose up -d

# Check health
curl http://localhost:3000/health
```

### Manual

```bash
# Install dependencies
npm install

# Build
npm run build

# Start server
npm start
```

## GitHub Actions

```yaml
name: Brand Check
on: [pull_request]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Validate copy
        run: |
          npx stylemcp validate src/copy/*.json \
            --min-score 80 \
            --format github
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `STYLEMCP_API_KEY` | API key for authentication | (none) |
| `GITHUB_WEBHOOK_SECRET` | GitHub webhook secret | (none) |

## MCP Tools

When used as an MCP server, StyleMCP provides these tools:

| Tool | Description |
|------|-------------|
| `validate_text` | Validate text against brand rules |
| `rewrite_to_style` | Rewrite text to match brand voice |
| `get_voice_rules` | Get voice and tone guidelines |
| `get_copy_patterns` | Get approved copy patterns |
| `get_cta_rules` | Get CTA guidelines |
| `get_tokens` | Get design tokens |
| `list_packs` | List available style packs |

## What Gets Validated?

The `saas` pack checks for:

### Vocabulary
- Use simple words: "use" not "utilize", "help" not "assist"
- Avoid jargon: "synergy", "leverage", "paradigm shift"
- Avoid weak intensifiers: "very", "really", "extremely"

### Patterns
- No "click here" (accessibility issue)
- No "we're sorry for any inconvenience" (corporate non-apology)
- No double "please" (sounds desperate)
- No starting with "Sorry" (lead with solutions)

### CTAs
- Avoid generic: "Submit", "OK", "Yes/No", "Click here"
- Use specific actions: "Save", "Create", "Sign up", "Export"
- Max 4 words

### Constraints
- Max 25 words per sentence
- No exclamation marks (in most contexts)
- First-person plural ("we", "our")
- Oxford comma

## License

MIT
