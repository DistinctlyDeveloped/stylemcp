import { describe, it, expect, beforeEach } from 'vitest';
import { validate, ValidateOptions } from './index.js';
import { Pack } from '../schema/index.js';

// Minimal test pack for validation testing
const createTestPack = (overrides?: Partial<Pack>): Pack => ({
  manifest: {
    name: 'test-pack',
    version: '1.0.0',
    description: 'Test pack for validator tests',
    files: {
      voice: 'voice.yaml',
      copyPatterns: 'copy_patterns.yaml',
      ctaRules: 'cta_rules.yaml',
      tokens: 'tokens.json',
      tests: 'tests.yaml',
    },
    config: {
      strictMode: false,
      minScore: 70,
    },
  },
  voice: {
    version: '1.0',
    name: 'Test Voice',
    description: 'Test voice profile for unit tests',
    tone: {
      attributes: [
        { name: 'professional', weight: 0.7, description: 'Maintain professional tone' },
        { name: 'clear', weight: 0.8, description: 'Be clear and concise' },
      ],
      summary: 'Professional and clear communication',
    },
    vocabulary: {
      rules: [
        { preferred: 'use', avoid: ['utilize', 'leverage'], context: 'general' },
      ],
      forbidden: ['synergy', 'game-changer'],
      encouraged: ['clear', 'simple', 'effective'],
    },
    doNot: [
      { pattern: 'going forward', isRegex: false, reason: 'Corporate jargon', severity: 'warning' },
    ],
    examples: [],
    constraints: {
      maxSentenceLength: 25,
      maxParagraphLength: 5,
      readingLevel: '8th-grade',
      contractions: 'allowed',
      oxfordComma: true,
    },
  },
  copyPatterns: {
    name: 'Test Patterns',
    version: '1.0.0',
    patterns: [],
  },
  ctaRules: {
    version: '1.0',
    name: 'Test CTA Rules',
    description: 'CTA rules for testing',
    guidelines: {
      verbStyle: 'imperative',
      maxWords: 4,
      capitalization: 'sentence',
      avoidWords: ['click', 'submit'],
      preferWords: ['get', 'start', 'try'],
    },
    categories: [
      {
        name: 'primary',
        ctas: [
          {
            id: 'get-started',
            text: 'Get Started',
            context: ['landing', 'signup'],
            priority: 'primary',
          },
        ],
      },
    ],
    antiPatterns: [
      { pattern: 'Click here', isRegex: false, reason: 'Not descriptive', suggestion: 'Describe the action' },
    ],
    contextualRules: [],
  },
  tokens: {
    colors: {},
    typography: {},
    spacing: {},
    effects: {},
  },
  tests: {
    name: 'Test Suite',
    version: '1.0.0',
    cases: [],
  },
  ...overrides,
});

describe('validate', () => {
  let testPack: Pack;

  beforeEach(() => {
    testPack = createTestPack();
  });

  describe('basic validation', () => {
    it('should return valid for compliant text', () => {
      const result = validate({
        pack: testPack,
        text: 'Welcome to our product. Get started today.',
      });

      expect(result.valid).toBe(true);
      expect(result.score).toBeGreaterThanOrEqual(70);
    });

    it('should return violations for forbidden words', () => {
      const result = validate({
        pack: testPack,
        text: 'Our synergy creates game-changer solutions.',
      });

      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations.some(v => v.text?.includes('synergy'))).toBe(true);
    });

    it('should suggest replacements for vocabulary violations', () => {
      const result = validate({
        pack: testPack,
        text: 'We utilize advanced technology.',
      });

      const violation = result.violations.find(v => v.text?.includes('utilize'));
      expect(violation).toBeDefined();
      expect(violation?.suggestion).toContain('use');
    });
  });

  describe('scoring', () => {
    it('should return 100 for text with no violations', () => {
      const result = validate({
        pack: testPack,
        text: 'Simple and clear text.',
      });

      expect(result.score).toBe(100);
    });

    it('should decrease score for each violation', () => {
      const cleanResult = validate({
        pack: testPack,
        text: 'Good text.',
      });

      const violationResult = validate({
        pack: testPack,
        text: 'We leverage synergy for game-changer results.',
      });

      expect(violationResult.score).toBeLessThan(cleanResult.score);
    });
  });

  describe('strict mode', () => {
    it('should fail with any violation in strict mode', () => {
      const strictPack = createTestPack({
        manifest: {
          ...createTestPack().manifest,
          config: { strictMode: true, minScore: 70 },
        },
      });

      const result = validate({
        pack: strictPack,
        text: 'Minor issue with synergy.',
      });

      expect(result.valid).toBe(false);
    });
  });

  describe('metadata', () => {
    it('should include pack metadata in result', () => {
      const result = validate({
        pack: testPack,
        text: 'Test text.',
      });

      expect(result.metadata.packName).toBe('test-pack');
      expect(result.metadata.packVersion).toBe('1.0.0');
      expect(result.metadata.validatedAt).toBeDefined();
    });

    it('should include summary counts', () => {
      const result = validate({
        pack: testPack,
        text: 'Test text.',
      });

      expect(result.summary).toHaveProperty('errors');
      expect(result.summary).toHaveProperty('warnings');
      expect(result.summary).toHaveProperty('info');
    });
  });

  describe('context handling', () => {
    it('should accept context options', () => {
      const result = validate({
        pack: testPack,
        text: 'Test text.',
        context: {
          type: 'marketing',
          component: 'hero',
        },
      });

      expect(result).toBeDefined();
      expect(result.valid).toBeDefined();
    });
  });
});
