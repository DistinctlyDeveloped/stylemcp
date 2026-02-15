import { z } from 'zod';

/**
 * Voice schema - defines tone, vocabulary, and communication style
 */

export const ToneAttributeSchema = z.object({
  name: z.string().describe('Attribute name, e.g., "professional", "friendly"'),
  weight: z.number().min(0).max(1).default(0.5).describe('How strongly this attribute should be present (0-1)'),
  description: z.string().optional().describe('What this tone means in practice'),
});

export const VocabularyRuleSchema = z.object({
  preferred: z.string().describe('The preferred term'),
  avoid: z.array(z.string()).describe('Terms to avoid in favor of preferred'),
  context: z.string().optional().describe('When this rule applies'),
});

export const DoNotSchema = z.object({
  pattern: z.string().describe('Pattern to match (string or regex)'),
  isRegex: z.boolean().default(false).describe('Whether pattern is a regex'),
  reason: z.string().describe('Why this should be avoided'),
  severity: z.enum(['error', 'warning', 'info']).default('warning'),
  suggestion: z.string().optional().describe('What to use instead'),
  exceptions: z.array(z.string()).optional().describe('Words/phrases that are allowed even if they match the pattern'),
  regexFlags: z.string().optional().describe('Custom regex flags (defaults to "gi")'),
});

export const ExampleSchema = z.object({
  bad: z.string().describe('Example of what NOT to write'),
  good: z.string().describe('Example of what TO write'),
  explanation: z.string().optional().describe('Why the good version is better'),
  context: z.string().optional().describe('Where this example applies'),
});

export const VoiceSchema = z.object({
  version: z.string().default('1.0').describe('Schema version'),
  name: z.string().describe('Name of this voice profile'),
  description: z.string().optional().describe('Description of this voice'),

  tone: z.object({
    attributes: z.array(ToneAttributeSchema).describe('Tone attributes with weights'),
    summary: z.string().optional().describe('One-line summary of overall tone'),
  }),

  vocabulary: z.object({
    rules: z.array(VocabularyRuleSchema).describe('Preferred vocabulary mappings'),
    forbidden: z.array(z.string()).default([]).describe('Words/phrases that are never allowed'),
    encouraged: z.array(z.string()).default([]).describe('Words/phrases to use when appropriate'),
  }),

  doNot: z.array(DoNotSchema).default([]).describe('Patterns and phrases to avoid'),

  examples: z.array(ExampleSchema).default([]).describe('Before/after examples'),

  constraints: z.object({
    maxSentenceLength: z.number().optional().describe('Maximum words per sentence'),
    maxParagraphLength: z.number().optional().describe('Maximum sentences per paragraph'),
    readingLevel: z.enum(['simple', 'accessible', '6th-grade', '8th-grade', 'moderate', 'technical', 'advanced']).optional(),
    personPov: z.enum(['first-singular', 'first-plural', 'second', 'second-person', 'third', 'second-or-third', 'first-plural-and-second', 'any']).optional().describe('Preferred point of view'),
    contractions: z.enum(['required', 'encouraged', 'allowed', 'discouraged', 'forbidden']).default('allowed'),
    oxfordComma: z.boolean().default(true),
  }).default({}),
});

export type ToneAttribute = z.infer<typeof ToneAttributeSchema>;
export type VocabularyRule = z.infer<typeof VocabularyRuleSchema>;
export type DoNot = z.infer<typeof DoNotSchema>;
export type Example = z.infer<typeof ExampleSchema>;
export type Voice = z.infer<typeof VoiceSchema>;
