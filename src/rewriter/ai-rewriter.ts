/**
 * AI-Powered Rewriter
 * Uses Claude to intelligently rewrite text while maintaining brand voice
 */

import { Pack, Violation } from '../schema/index.js';

export interface AIRewriteOptions {
  pack: Pack;
  text: string;
  violations: Violation[];
  context?: {
    type?: 'ui-copy' | 'marketing' | 'docs' | 'support' | 'general';
    component?: string;
  };
  /** API key for Claude */
  apiKey?: string;
}

export interface AIRewriteResult {
  original: string;
  rewritten: string;
  explanation: string;
  tokensUsed: {
    input: number;
    output: number;
  };
}

/**
 * Build the system prompt for brand-aware rewriting
 */
function buildSystemPrompt(pack: Pack): string {
  const voice = pack.voice;
  
  let prompt = `You are a brand copy editor. Your job is to rewrite text to match a specific brand voice while fixing style violations.

BRAND VOICE:
`;

  if (voice.tone?.summary) {
    prompt += `Tone: ${voice.tone.summary}\n`;
  }

  if (voice.tone?.attributes) {
    const attrs = voice.tone.attributes
      .sort((a, b) => (b.weight || 0.5) - (a.weight || 0.5))
      .slice(0, 3)
      .map(a => a.name)
      .join(', ');
    prompt += `Key attributes: ${attrs}\n`;
  }

  // Add vocabulary rules
  if (voice.vocabulary?.rules && voice.vocabulary.rules.length > 0) {
    prompt += `\nVOCABULARY RULES:\n`;
    for (const rule of voice.vocabulary.rules.slice(0, 10)) {
      const avoid = Array.isArray(rule.avoid) ? rule.avoid.join(', ') : rule.avoid;
      prompt += `- Use "${rule.preferred}" instead of: ${avoid}\n`;
    }
  }

  // Add forbidden words
  if (voice.vocabulary?.forbidden && voice.vocabulary.forbidden.length > 0) {
    prompt += `\nFORBIDDEN WORDS (never use):\n`;
    prompt += voice.vocabulary.forbidden.slice(0, 15).join(', ') + '\n';
  }

  // Add do-not patterns
  if (voice.doNot && voice.doNot.length > 0) {
    prompt += `\nPATTERNS TO AVOID:\n`;
    for (const rule of voice.doNot.slice(0, 10)) {
      prompt += `- "${rule.pattern}": ${rule.reason}\n`;
      if (rule.suggestion) {
        prompt += `  Suggestion: ${rule.suggestion}\n`;
      }
    }
  }

  prompt += `
INSTRUCTIONS:
1. Rewrite the text to fix all violations while preserving the original meaning
2. Match the brand voice described above
3. Keep the same approximate length
4. Preserve any proper nouns, technical terms, or product names
5. Return ONLY the rewritten text, no explanations or preamble
`;

  return prompt;
}

/**
 * Build the user prompt with violations context
 */
function buildUserPrompt(text: string, violations: Violation[], context?: AIRewriteOptions['context']): string {
  let prompt = '';

  if (context?.type) {
    prompt += `Content type: ${context.type}\n`;
  }
  if (context?.component) {
    prompt += `UI component: ${context.component}\n`;
  }

  prompt += `\nTEXT TO REWRITE:\n"${text}"\n`;

  if (violations.length > 0) {
    prompt += `\nVIOLATIONS TO FIX:\n`;
    for (const v of violations.slice(0, 10)) {
      prompt += `- ${v.message}`;
      if (v.suggestion) {
        prompt += ` (suggestion: ${v.suggestion})`;
      }
      prompt += '\n';
    }
  }

  prompt += `\nRewrite the text to fix these issues while maintaining the brand voice. Return only the rewritten text.`;

  return prompt;
}

/**
 * Rewrite text using Claude AI
 */
export async function aiRewrite(options: AIRewriteOptions): Promise<AIRewriteResult> {
  const { pack, text, violations, context, apiKey } = options;

  const effectiveApiKey = apiKey || process.env.ANTHROPIC_API_KEY;
  
  if (!effectiveApiKey) {
    throw new Error('AI rewrite requires an Anthropic API key. Set ANTHROPIC_API_KEY environment variable or pass apiKey option.');
  }

  const systemPrompt = buildSystemPrompt(pack);
  const userPrompt = buildUserPrompt(text, violations, context);

  // Call Claude API directly (avoiding SDK to keep dependencies light)
  // Add 30s timeout to prevent hung connections
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  let response: Response;
  try {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': effectiveApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-5-haiku-20241022',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ],
      }),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('AI rewrite request timed out after 30 seconds');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error: ${response.status} - ${error}`);
  }

  const data = await response.json() as {
    content: Array<{ type: string; text: string }>;
    usage: { input_tokens: number; output_tokens: number };
  };

  const rewritten = data.content[0]?.text?.trim() || text;

  return {
    original: text,
    rewritten,
    explanation: `AI-powered rewrite addressing ${violations.length} violation(s)`,
    tokensUsed: {
      input: data.usage?.input_tokens || 0,
      output: data.usage?.output_tokens || 0,
    },
  };
}

/**
 * Check if AI rewriting is available
 */
export function isAIRewriteAvailable(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

/**
 * Estimate cost of AI rewrite (for metering/billing)
 * Using Claude 3.5 Haiku pricing: $0.25/1M input, $1.25/1M output
 */
export function estimateAIRewriteCost(inputTokens: number, outputTokens: number): number {
  const inputCost = (inputTokens / 1_000_000) * 0.25;
  const outputCost = (outputTokens / 1_000_000) * 1.25;
  return inputCost + outputCost;
}
