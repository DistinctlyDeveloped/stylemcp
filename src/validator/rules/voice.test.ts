import { describe, it, expect } from 'vitest';
import { checkVoiceRules } from './voice.js';
import { Voice } from '../../schema/index.js';

/**
 * Minimal voice fixture with only the ALL CAPS doNot rule for focused testing
 */
const createVoiceWithAllCapsRule = (overrides?: {
  pattern?: string;
  exceptions?: string[];
  regexFlags?: string;
}): Voice => ({
  version: '1.0',
  name: 'Test Legal Voice',
  tone: {
    attributes: [{ name: 'professional', weight: 0.8 }],
    summary: 'Professional legal tone',
  },
  vocabulary: {
    rules: [],
    forbidden: [],
    encouraged: [],
  },
  doNot: [
    {
      pattern: overrides?.pattern ?? '\\b[A-Z]{5,}\\b',
      isRegex: true,
      regexFlags: overrides?.regexFlags ?? 'g',
      reason: 'ALL CAPS reduces readability',
      severity: 'warning',
      suggestion: 'Use bold or defined terms instead of ALL CAPS',
      ...(overrides?.exceptions ? { exceptions: overrides.exceptions } : {}),
    },
  ],
  examples: [],
  constraints: {
    contractions: 'allowed',
    oxfordComma: true,
  },
});

describe('voice doNot ALL CAPS rule', () => {
  describe('word boundary anchors', () => {
    it('should flag standalone ALL CAPS words of 5+ characters', () => {
      const voice = createVoiceWithAllCapsRule();
      const violations = checkVoiceRules('THIS IS ALL ABOUT SHOUTING LOUDLY', voice);
      expect(violations.some(v => v.text === 'SHOUTING')).toBe(true);
      expect(violations.some(v => v.text === 'LOUDLY')).toBe(true);
    });

    it('should not flag uppercase runs embedded in mixed-case words', () => {
      const voice = createVoiceWithAllCapsRule();
      const violations = checkVoiceRules('The testINPUThere was invalid', voice);
      expect(violations).toHaveLength(0);
    });

    it('should not flag words shorter than 5 uppercase characters', () => {
      const voice = createVoiceWithAllCapsRule();
      const violations = checkVoiceRules('NDA and GDPR are fine', voice);
      expect(violations).toHaveLength(0);
    });
  });

  describe('exceptions whitelist', () => {
    it('should not flag whitelisted legal acronyms like HIPAA and CCPA', () => {
      const voice = createVoiceWithAllCapsRule({
        exceptions: ['HIPAA', 'CCPA', 'EDGAR', 'RESPA', 'ERISA', 'DISCLAIMER', 'INDEMNIFICATION'],
      });
      const text = 'HIPAA and CCPA require disclosure. See the DISCLAIMER section.';
      const violations = checkVoiceRules(text, voice);
      expect(violations).toHaveLength(0);
    });

    it('should still flag non-whitelisted ALL CAPS words', () => {
      const voice = createVoiceWithAllCapsRule({
        exceptions: ['HIPAA', 'CCPA'],
      });
      const text = 'HIPAA compliance is required. DO NOT USE EXCESSIVE SHOUTING.';
      const violations = checkVoiceRules(text, voice);
      // HIPAA is whitelisted, but EXCESSIVE and SHOUTING are not
      expect(violations.some(v => v.text === 'HIPAA')).toBe(false);
      expect(violations.some(v => v.text === 'EXCESSIVE')).toBe(true);
      expect(violations.some(v => v.text === 'SHOUTING')).toBe(true);
    });

    it('should handle case-insensitive exception matching', () => {
      const voice = createVoiceWithAllCapsRule({
        exceptions: ['hipaa'], // lowercase in config
      });
      const text = 'HIPAA regulations apply here.';
      const violations = checkVoiceRules(text, voice);
      expect(violations).toHaveLength(0);
    });

    it('should flag long legal terms like INDEMNIFICATION when not whitelisted', () => {
      const voice = createVoiceWithAllCapsRule({ exceptions: [] });
      const text = 'The INDEMNIFICATION clause is standard.';
      const violations = checkVoiceRules(text, voice);
      expect(violations.some(v => v.text === 'INDEMNIFICATION')).toBe(true);
    });

    it('should not flag INDEMNIFICATION when whitelisted', () => {
      const voice = createVoiceWithAllCapsRule({
        exceptions: ['INDEMNIFICATION'],
      });
      const text = 'The INDEMNIFICATION clause is standard.';
      const violations = checkVoiceRules(text, voice);
      expect(violations).toHaveLength(0);
    });
  });

  describe('regression: old pattern without boundaries', () => {
    it('should have flagged HIPAA with the old pattern (demonstrating the bug)', () => {
      // Old pattern without word boundaries, no exceptions, case-sensitive
      const voice = createVoiceWithAllCapsRule({
        pattern: '[A-Z]{5,}',
        regexFlags: 'g',
        exceptions: [],
      });
      const text = 'HIPAA compliance is mandatory.';
      const violations = checkVoiceRules(text, voice);
      // The old pattern WOULD flag HIPAA - this demonstrates the bug existed
      expect(violations.some(v => v.text === 'HIPAA')).toBe(true);
    });
  });
});
