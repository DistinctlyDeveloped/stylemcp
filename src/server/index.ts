#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { loadPack, getPacksDirectory, listAvailablePacks } from '../utils/pack-loader.js';
import { validate } from '../validator/index.js';
import { rewrite, rewriteMinimal, rewriteAggressive, formatChanges } from '../rewriter/index.js';
import { Pack } from '../schema/index.js';
import { join } from 'path';

// Server state
let currentPack: Pack | null = null;
let currentPackName: string = 'saas';

/**
 * Load a pack by name
 */
async function ensurePack(packName?: string): Promise<Pack> {
  const targetPack = packName || currentPackName;

  if (currentPack && currentPackName === targetPack) {
    return currentPack;
  }

  const packPath = join(getPacksDirectory(), targetPack);
  const result = await loadPack({ packPath });

  if (result.errors.length > 0) {
    console.error('Pack loading warnings:', result.errors);
  }

  currentPack = result.pack;
  currentPackName = targetPack;

  return currentPack;
}

/**
 * Create and configure the MCP server
 */
function createServer(): Server {
  const server = new Server(
    {
      name: 'stylemcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        resources: {},
      },
    }
  );

  // List available tools
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'validate_text',
          description: 'Validate text against brand/voice rules. Returns a compliance score (0-100), list of violations, and suggestions for fixes.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The text to validate',
              },
              pack: {
                type: 'string',
                description: 'Style pack to use (default: saas)',
              },
              context_type: {
                type: 'string',
                enum: ['ui-copy', 'marketing', 'docs', 'support', 'general'],
                description: 'Type of content being validated',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'rewrite_to_style',
          description: 'Rewrite text to conform to brand/voice rules. Makes minimal changes to fix violations.',
          inputSchema: {
            type: 'object',
            properties: {
              text: {
                type: 'string',
                description: 'The text to rewrite',
              },
              pack: {
                type: 'string',
                description: 'Style pack to use (default: saas)',
              },
              mode: {
                type: 'string',
                enum: ['minimal', 'normal', 'aggressive'],
                description: 'How aggressively to rewrite (minimal=errors only, normal=errors+warnings, aggressive=all)',
              },
              context_type: {
                type: 'string',
                enum: ['ui-copy', 'marketing', 'docs', 'support', 'general'],
                description: 'Type of content being rewritten',
              },
            },
            required: ['text'],
          },
        },
        {
          name: 'get_voice_rules',
          description: 'Get the voice/tone rules including vocabulary preferences, forbidden phrases, and writing examples.',
          inputSchema: {
            type: 'object',
            properties: {
              pack: {
                type: 'string',
                description: 'Style pack to use (default: saas)',
              },
              section: {
                type: 'string',
                enum: ['all', 'tone', 'vocabulary', 'doNot', 'examples', 'constraints'],
                description: 'Which section of voice rules to return',
              },
            },
          },
        },
        {
          name: 'get_copy_patterns',
          description: 'Get reusable copy patterns for UI situations (errors, empty states, success messages, etc.).',
          inputSchema: {
            type: 'object',
            properties: {
              pack: {
                type: 'string',
                description: 'Style pack to use (default: saas)',
              },
              category: {
                type: 'string',
                enum: ['error', 'empty-state', 'success', 'loading', 'confirmation', 'onboarding', 'tooltip', 'notification', 'feature-gate', 'all'],
                description: 'Filter by pattern category',
              },
            },
          },
        },
        {
          name: 'get_cta_rules',
          description: 'Get CTA (call-to-action) guidelines and approved CTAs by context.',
          inputSchema: {
            type: 'object',
            properties: {
              pack: {
                type: 'string',
                description: 'Style pack to use (default: saas)',
              },
              category: {
                type: 'string',
                description: 'Filter by CTA category (e.g., "Primary Actions", "Destructive Actions")',
              },
            },
          },
        },
        {
          name: 'get_tokens',
          description: 'Get design tokens (colors, typography, spacing, etc.).',
          inputSchema: {
            type: 'object',
            properties: {
              pack: {
                type: 'string',
                description: 'Style pack to use (default: saas)',
              },
              type: {
                type: 'string',
                enum: ['all', 'colors', 'typography', 'spacing', 'shadows', 'borderRadius'],
                description: 'Type of tokens to return',
              },
            },
          },
        },
        {
          name: 'suggest_ctas',
          description: 'Suggest appropriate CTAs for a given context or situation.',
          inputSchema: {
            type: 'object',
            properties: {
              context: {
                type: 'string',
                description: 'The context/situation needing a CTA (e.g., "form submission", "delete confirmation")',
              },
              pack: {
                type: 'string',
                description: 'Style pack to use (default: saas)',
              },
            },
            required: ['context'],
          },
        },
        {
          name: 'list_packs',
          description: 'List all available style packs.',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
      ],
    };
  });

  // Handle tool calls
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      switch (name) {
        case 'validate_text': {
          if (!args || typeof args.text !== 'string') {
            throw new Error('Missing required "text" string');
          }
          const pack = await ensurePack(args?.pack as string);
          const result = validate({
            pack,
            text: args?.text as string,
            context: args?.context_type ? { type: args.context_type as any } : undefined,
          });
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result, null, 2),
              },
            ],
          };
        }

        case 'rewrite_to_style': {
          if (!args || typeof args.text !== 'string') {
            throw new Error('Missing required "text" string');
          }
          const pack = await ensurePack(args?.pack as string);
          const mode = (args?.mode as string) || 'normal';

          let result;
          const options = {
            pack,
            text: args?.text as string,
            context: args?.context_type ? { type: args.context_type as any } : undefined,
          };

          if (mode === 'minimal') {
            result = rewriteMinimal(options);
          } else if (mode === 'aggressive') {
            result = rewriteAggressive(options);
          } else {
            result = rewrite(options);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...result,
                  summary: formatChanges(result),
                }, null, 2),
              },
            ],
          };
        }

        case 'get_voice_rules': {
          const pack = await ensurePack(args?.pack as string);
          const section = (args?.section as string) || 'all';

          let data: any;
          if (section === 'all') {
            data = pack.voice;
          } else {
            data = (pack.voice as any)[section];
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2),
              },
            ],
          };
        }

        case 'get_copy_patterns': {
          const pack = await ensurePack(args?.pack as string);
          const category = args?.category as string;

          let patterns = pack.copyPatterns.patterns;
          if (category && category !== 'all') {
            patterns = patterns.filter(p => p.category === category);
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(patterns, null, 2),
              },
            ],
          };
        }

        case 'get_cta_rules': {
          const pack = await ensurePack(args?.pack as string);
          const category = args?.category as string;

          let data: any = {
            guidelines: pack.ctaRules.guidelines,
            categories: pack.ctaRules.categories,
            antiPatterns: pack.ctaRules.antiPatterns,
          };

          if (category) {
            data.categories = pack.ctaRules.categories.filter(
              c => c.name.toLowerCase().includes(category.toLowerCase())
            );
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2),
              },
            ],
          };
        }

        case 'get_tokens': {
          const pack = await ensurePack(args?.pack as string);
          const type = (args?.type as string) || 'all';

          let data: any;
          if (type === 'all') {
            data = pack.tokens;
          } else {
            data = (pack.tokens as any)[type];
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(data, null, 2),
              },
            ],
          };
        }

        case 'suggest_ctas': {
          if (!args || typeof args.context !== 'string') {
            throw new Error('Missing required "context" string');
          }
          const pack = await ensurePack(args?.pack as string);
          const context = (args?.context as string).toLowerCase();

          // Find relevant CTAs based on context
          const suggestions: any[] = [];

          for (const category of pack.ctaRules.categories) {
            for (const cta of category.ctas) {
              const matchesContext = cta.context.some(c =>
                c.toLowerCase().includes(context) || context.includes(c.toLowerCase())
              );

              if (matchesContext) {
                suggestions.push({
                  text: cta.text,
                  category: category.name,
                  priority: cta.priority,
                  contexts: cta.context,
                });
              }
            }
          }

          // Also check contextual rules for preferred CTAs
          for (const rule of pack.ctaRules.contextualRules) {
            if (rule.context.toLowerCase().includes(context)) {
              suggestions.push({
                type: 'contextual_recommendation',
                context: rule.context,
                preferred: rule.preferred,
                avoid: rule.forbidden,
              });
            }
          }

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  context: args?.context,
                  suggestions: suggestions.slice(0, 10),
                  guidelines: pack.ctaRules.guidelines,
                }, null, 2),
              },
            ],
          };
        }

        case 'list_packs': {
          const packs = await listAvailablePacks();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ available_packs: packs }, null, 2),
              },
            ],
          };
        }

        default:
          throw new Error(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: error instanceof Error ? error.message : 'Unknown error',
            }),
          },
        ],
        isError: true,
      };
    }
  });

  // List resources (pack files)
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const packs = await listAvailablePacks();
    const resources = [];

    for (const packName of packs) {
      resources.push({
        uri: `stylemcp://pack/${packName}/manifest`,
        name: `${packName} manifest`,
        mimeType: 'application/json',
      });
      resources.push({
        uri: `stylemcp://pack/${packName}/voice`,
        name: `${packName} voice rules`,
        mimeType: 'application/json',
      });
      resources.push({
        uri: `stylemcp://pack/${packName}/copy-patterns`,
        name: `${packName} copy patterns`,
        mimeType: 'application/json',
      });
      resources.push({
        uri: `stylemcp://pack/${packName}/cta-rules`,
        name: `${packName} CTA rules`,
        mimeType: 'application/json',
      });
      resources.push({
        uri: `stylemcp://pack/${packName}/tokens`,
        name: `${packName} design tokens`,
        mimeType: 'application/json',
      });
    }

    return { resources };
  });

  // Read resources
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;
    const match = uri.match(/^stylemcp:\/\/pack\/([^/]+)\/(.+)$/);

    if (!match) {
      throw new Error(`Invalid resource URI: ${uri}`);
    }

    const [, packName, resource] = match;
    const pack = await ensurePack(packName);

    let content: any;
    switch (resource) {
      case 'manifest':
        content = pack.manifest;
        break;
      case 'voice':
        content = pack.voice;
        break;
      case 'copy-patterns':
        content = pack.copyPatterns;
        break;
      case 'cta-rules':
        content = pack.ctaRules;
        break;
      case 'tokens':
        content = pack.tokens;
        break;
      default:
        throw new Error(`Unknown resource: ${resource}`);
    }

    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(content, null, 2),
        },
      ],
    };
  });

  return server;
}

/**
 * Main entry point
 */
async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();

  await server.connect(transport);
  console.error('StyleMCP server running on stdio');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
