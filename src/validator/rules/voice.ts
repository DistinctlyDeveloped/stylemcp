import { Voice, Violation } from '../../schema/index.js';
import { createViolation, escapeRegex, slugify } from '../utils.js';

/**
 * Check text against voice rules (vocabulary, doNot, forbidden phrases)
 */
export function checkVoiceRules(text: string, voice: Voice): Violation[] {
  const violations: Violation[] = [];

  // Check forbidden words
  violations.push(...checkForbiddenWords(text, voice.vocabulary.forbidden));

  // Check vocabulary preferences
  violations.push(...checkVocabularyRules(text, voice.vocabulary.rules));

  // Check doNot patterns
  violations.push(...checkDoNotPatterns(text, voice.doNot));

  return violations;
}

/**
 * Check for forbidden words/phrases
 */
function checkForbiddenWords(text: string, forbidden: string[]): Violation[] {
  const violations: Violation[] = [];
  const lowerText = text.toLowerCase();

  for (const word of forbidden) {
    const lowerWord = word.toLowerCase();
    // Use word boundary matching
    const regex = new RegExp(`\\b${escapeRegex(lowerWord)}\\b`, 'gi');
    let match;

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
 * Check vocabulary preference rules (use X instead of Y)
 */
function checkVocabularyRules(
  text: string,
  rules: Voice['vocabulary']['rules']
): Violation[] {
  const violations: Violation[] = [];

  for (const rule of rules) {
    for (const avoid of rule.avoid) {
      const regex = new RegExp(`\\b${escapeRegex(avoid)}\\b`, 'gi');
      let match;

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
  }

  return violations;
}

/**
 * Check doNot patterns
 */
function checkDoNotPatterns(text: string, doNots: Voice['doNot']): Violation[] {
  const violations: Violation[] = [];

  for (const doNot of doNots) {
    let regex: RegExp;

    try {
      if (doNot.isRegex) {
        regex = new RegExp(doNot.pattern, 'gi');
      } else {
        // Exact string match with word boundaries
        regex = new RegExp(`${escapeRegex(doNot.pattern)}`, 'gi');
      }
    } catch {
      // Invalid regex, skip
      continue;
    }

    let match;
    while ((match = regex.exec(text)) !== null) {
      // Generate a rule ID from the pattern
      const ruleId = doNot.isRegex
        ? `doNot.pattern-${doNots.indexOf(doNot)}`
        : `doNot.${slugify(doNot.pattern)}`;

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
