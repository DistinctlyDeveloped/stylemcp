import { CTARules, Violation } from '../../schema/index.js';
import { createViolation, escapeRegex } from '../utils.js';

export interface CtaContext {
  type?: 'ui-copy' | 'marketing' | 'docs' | 'support' | 'general';
  component?: string;
}

/**
 * Check text against CTA rules
 * Note: This primarily checks short text that appears to be CTAs (buttons, links)
 */
export function checkCtaRules(
  text: string,
  ctaRules: CTARules,
  context?: CtaContext
): Violation[] {
  const violations: Violation[] = [];

  // Only apply CTA rules to short text (likely buttons/links)
  // Longer text should only check for anti-patterns like "click here"
  const isShortText = text.split(/\s+/).length <= 6;
  const isButton = context?.component === 'button';

  // Check anti-patterns (applies to all text)
  violations.push(...checkCtaAntiPatterns(text, ctaRules.antiPatterns));

  // Check guidelines only for button-like text
  if (isShortText || isButton) {
    violations.push(...checkCtaGuidelines(text, ctaRules.guidelines));
  }

  // Check contextual rules if we have context
  if (context) {
    violations.push(...checkContextualRules(text, ctaRules.contextualRules, context));
  }

  return violations;
}

/**
 * Check for CTA anti-patterns
 */
function checkCtaAntiPatterns(
  text: string,
  antiPatterns: CTARules['antiPatterns']
): Violation[] {
  const violations: Violation[] = [];

  for (const pattern of antiPatterns) {
    let regex: RegExp;

    try {
      if (pattern.isRegex) {
        regex = new RegExp(pattern.pattern, 'gi');
      } else {
        regex = new RegExp(`^${escapeRegex(pattern.pattern)}$`, 'i');
      }
    } catch {
      continue;
    }

    const match = regex.exec(text);
    if (match) {
      violations.push(
        createViolation(
          'cta.antiPattern',
          'warning',
          pattern.reason,
          match[0],
          { start: match.index, end: match.index + match[0].length },
          pattern.suggestion
        )
      );
    }
  }

  return violations;
}

/**
 * Check CTA guidelines
 */
function checkCtaGuidelines(
  text: string,
  guidelines: CTARules['guidelines']
): Violation[] {
  const violations: Violation[] = [];

  // Check max words
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;
  if (guidelines.maxWords && wordCount > guidelines.maxWords) {
    violations.push(
      createViolation(
        'cta.maxWords',
        'info',
        `CTA has ${wordCount} words, max is ${guidelines.maxWords}`,
        text,
        { start: 0, end: text.length },
        'Shorten to be more direct'
      )
    );
  }

  // Check for avoided words (these are errors, not just warnings)
  for (const avoidWord of guidelines.avoidWords) {
    const regex = new RegExp(`\\b${escapeRegex(avoidWord)}\\b`, 'gi');
    const match = regex.exec(text);
    if (match) {
      violations.push(
        createViolation(
          'cta.avoidWord',
          'error',
          `Avoid "${avoidWord}" in CTAs`,
          match[0],
          { start: match.index, end: match.index + match[0].length },
          `Use a more specific action verb`
        )
      );
    }
  }

  // Check capitalization
  if (guidelines.capitalization === 'sentence' && text.length > 1) {
    const words = text.split(/\s+/);
    // First word should be capitalized, rest should be lowercase (unless proper nouns)
    const firstWord = words[0];
    if (firstWord && firstWord[0] !== firstWord[0].toUpperCase()) {
      violations.push(
        createViolation(
          'cta.capitalization',
          'info',
          'CTA should use sentence case (capitalize first letter)',
          text,
          { start: 0, end: text.length }
        )
      );
    }
  }

  return violations;
}

/**
 * Check contextual CTA rules
 */
function checkContextualRules(
  text: string,
  contextualRules: CTARules['contextualRules'],
  context: CtaContext
): Violation[] {
  const violations: Violation[] = [];
  const lowerText = text.toLowerCase();
  const contextType = context.type?.toLowerCase();
  const contextComponent = context.component?.toLowerCase();

  for (const rule of contextualRules) {
    // Simple context matching
    const ruleContext = rule.context.toLowerCase();
    const contextMatches =
      (!!contextType && ruleContext.includes(contextType)) ||
      (!!contextComponent && ruleContext.includes(contextComponent));

    if (!contextMatches) continue;

    // Check forbidden in context
    for (const forbidden of rule.forbidden) {
      if (lowerText === forbidden.toLowerCase()) {
        violations.push(
          createViolation(
            'cta.contextForbidden',
            'warning',
            `"${text}" should not be used in ${rule.context}`,
            text,
            { start: 0, end: text.length },
            rule.preferred.length > 0 ? `Try: ${rule.preferred.join(', ')}` : undefined
          )
        );
      }
    }
  }

  return violations;
}

// Utility functions (createViolation, escapeRegex) imported from ../utils.js
