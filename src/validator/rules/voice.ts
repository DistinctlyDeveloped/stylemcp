import { Voice, Violation } from '../../schema/index.js';
import { createViolation, escapeRegex, slugify } from '../utils.js';

/**
 * Compiled regex cache for voice rules - keyed by Voice object for efficient reuse
 */
interface CompiledVoiceRules {
  forbidden: Array<{ word: string; regex: RegExp }>;
  vocabulary: Array<{ rule: Voice['vocabulary']['rules'][0]; avoid: string; regex: RegExp }>;
  doNots: Array<{ doNot: Voice['doNot'][0]; regex: RegExp; ruleId: string }>;
}

const compiledRulesCache = new WeakMap<Voice, CompiledVoiceRules>();

/**
 * Compile and cache regex patterns for a voice object
 */
function getCompiledRules(voice: Voice): CompiledVoiceRules {
  let compiled = compiledRulesCache.get(voice);
  
  if (!compiled) {
    compiled = {
      forbidden: [],
      vocabulary: [],
      doNots: []
    };

    // Compile forbidden words
    for (const word of voice.vocabulary.forbidden) {
      try {
        const regex = new RegExp(`\\b${escapeRegex(word.toLowerCase())}\\b`, 'gi');
        compiled.forbidden.push({ word, regex });
      } catch {
        // Skip invalid patterns
        continue;
      }
    }

    // Compile vocabulary rules
    for (const rule of voice.vocabulary.rules) {
      for (const avoid of rule.avoid) {
        try {
          const regex = new RegExp(`\\b${escapeRegex(avoid)}\\b`, 'gi');
          compiled.vocabulary.push({ rule, avoid, regex });
        } catch {
          // Skip invalid patterns
          continue;
        }
      }
    }

    // Compile doNot patterns
    for (let i = 0; i < voice.doNot.length; i++) {
      const doNot = voice.doNot[i];
      try {
        let regex: RegExp;
        if (doNot.isRegex) {
          regex = new RegExp(doNot.pattern, 'gi');
        } else {
          regex = new RegExp(`${escapeRegex(doNot.pattern)}`, 'gi');
        }

        const ruleId = doNot.isRegex
          ? `doNot.pattern-${i}`
          : `doNot.${slugify(doNot.pattern)}`;

        compiled.doNots.push({ doNot, regex, ruleId });
      } catch {
        // Skip invalid regex patterns
        continue;
      }
    }

    compiledRulesCache.set(voice, compiled);
  }

  return compiled;
}

/**
 * Check text against voice rules (vocabulary, doNot, forbidden phrases)
 * Now uses cached compiled regexes for improved performance
 */
export function checkVoiceRules(text: string, voice: Voice): Violation[] {
  const violations: Violation[] = [];
  const compiled = getCompiledRules(voice);

  // Check forbidden words using cached regexes
  violations.push(...checkForbiddenWords(text, compiled.forbidden));

  // Check vocabulary preferences using cached regexes
  violations.push(...checkVocabularyRules(text, compiled.vocabulary));

  // Check doNot patterns using cached regexes
  violations.push(...checkDoNotPatterns(text, compiled.doNots));

  return violations;
}

/**
 * Check for forbidden words/phrases using precompiled regexes
 */
function checkForbiddenWords(text: string, compiled: CompiledVoiceRules['forbidden']): Violation[] {
  const violations: Violation[] = [];

  for (const { word, regex } of compiled) {
    let match;
    // Reset regex state
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      violations.push(
        createViolation(
          'vocabulary.forbidden',
          'error',
          `Forbidden phrase: "${word}"`,
          match[0],
          { start: match.index, end: match.index + match[0].length },
          `Remove or replace "${word}"`
        )
      );
    }
  }

  return violations;
}

/**
 * Check vocabulary preference rules (use X instead of Y) using precompiled regexes
 */
function checkVocabularyRules(
  text: string,
  compiled: CompiledVoiceRules['vocabulary']
): Violation[] {
  const violations: Violation[] = [];

  for (const { rule, avoid, regex } of compiled) {
    let match;
    // Reset regex state
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      violations.push(
        createViolation(
          'vocabulary.preferred',
          'error',
          `Use "${rule.preferred}" instead of "${avoid}"`,
          match[0],
          { start: match.index, end: match.index + match[0].length },
          rule.preferred
        )
      );
    }
  }

  return violations;
}

/**
 * Check doNot patterns using precompiled regexes
 */
function checkDoNotPatterns(text: string, compiled: CompiledVoiceRules['doNots']): Violation[] {
  const violations: Violation[] = [];

  for (const { doNot, regex, ruleId } of compiled) {
    let match;
    // Reset regex state
    regex.lastIndex = 0;

    while ((match = regex.exec(text)) !== null) {
      violations.push(
        createViolation(
          ruleId,
          doNot.severity,
          doNot.reason,
          match[0],
          { start: match.index, end: match.index + match[0].length },
          doNot.suggestion
        )
      );
    }
  }

  return violations;
}

// Utility functions (createViolation, escapeRegex, slugify) imported from ../utils.js
