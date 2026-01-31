import { Voice, Violation } from '../../schema/index.js';
import { createViolation, escapeRegex } from '../utils.js';

type Constraints = Voice['constraints'];

/**
 * Check text against writing constraints
 */
export function checkConstraints(text: string, constraints: Constraints): Violation[] {
  const violations: Violation[] = [];

  if (!constraints) return violations;

  // Check sentence length
  if (constraints.maxSentenceLength) {
    violations.push(...checkSentenceLength(text, constraints.maxSentenceLength));
  }

  // Check paragraph length
  if (constraints.maxParagraphLength) {
    violations.push(...checkParagraphLength(text, constraints.maxParagraphLength));
  }

  // Check contractions
  if (constraints.contractions) {
    violations.push(...checkContractions(text, constraints.contractions));
  }

  // Check Oxford comma
  if (constraints.oxfordComma !== undefined) {
    violations.push(...checkOxfordComma(text, constraints.oxfordComma));
  }

  return violations;
}

/**
 * Check for overly long sentences
 */
function checkSentenceLength(text: string, maxWords: number): Violation[] {
  const violations: Violation[] = [];

  // Split into sentences (simple approach)
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);

  let position = 0;
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/).filter(w => w.length > 0);

    if (words.length > maxWords) {
      const start = text.indexOf(sentence.trim(), position);
      const end = start + sentence.trim().length;

      violations.push(
        createViolation(
          'constraints.maxSentenceLength',
          'error',
          `Sentence has ${words.length} words, max is ${maxWords}`,
          sentence.trim(),
          { start, end },
          'Break into shorter sentences'
        )
      );
    }

    position = text.indexOf(sentence, position) + sentence.length;
  }

  return violations;
}

/**
 * Check for overly long paragraphs
 */
function checkParagraphLength(text: string, maxSentences: number): Violation[] {
  const violations: Violation[] = [];

  // Split into paragraphs
  const paragraphs = text.split(/\n\n+/).filter(p => p.trim().length > 0);

  let position = 0;
  for (const paragraph of paragraphs) {
    const sentences = paragraph.split(/[.!?]+/).filter(s => s.trim().length > 0);

    if (sentences.length > maxSentences) {
      const start = text.indexOf(paragraph, position);
      const end = start + paragraph.length;

      violations.push(
        createViolation(
          'constraints.maxParagraphLength',
          'info',
          `Paragraph has ${sentences.length} sentences, max is ${maxSentences}`,
          paragraph.slice(0, 50) + '...',
          { start, end },
          'Break into shorter paragraphs'
        )
      );
    }

    position = text.indexOf(paragraph, position) + paragraph.length;
  }

  return violations;
}

/**
 * Check contraction usage
 */
function checkContractions(
  text: string,
  rule: 'required' | 'encouraged' | 'allowed' | 'discouraged' | 'forbidden'
): Violation[] {
  const violations: Violation[] = [];

  // Common contractions (all lowercase for consistent matching)
  const contractions = [
    "don't", "doesn't", "didn't", "can't", "couldn't", "won't", "wouldn't",
    "shouldn't", "isn't", "aren't", "wasn't", "weren't", "hasn't", "haven't",
    "hadn't", "it's", "that's", "what's", "who's", "there's", "here's",
    "let's", "i'm", "you're", "we're", "they're", "he's", "she's",
    "i'll", "you'll", "we'll", "they'll", "he'll", "she'll", "it'll",
    "i've", "you've", "we've", "they've", "i'd", "you'd", "we'd", "they'd"
  ];

  // Expanded forms (matching order with contractions array)
  const expanded = [
    "do not", "does not", "did not", "cannot", "could not", "will not", "would not",
    "should not", "is not", "are not", "was not", "were not", "has not", "have not",
    "had not", "it is", "that is", "what is", "who is", "there is", "here is",
    "let us", "I am", "you are", "we are", "they are", "he is", "she is",
    "I will", "you will", "we will", "they will", "he will", "she will", "it will",
    "I have", "you have", "we have", "they have", "I would", "you would", "we would", "they would"
  ];

  if (rule === 'forbidden' || rule === 'discouraged') {
    // 'forbidden' = warning, 'discouraged' = info
    const severity = rule === 'forbidden' ? 'warning' : 'info';
    const message = rule === 'forbidden' ? 'Contractions are not allowed' : 'Contractions are discouraged';
    // Check for contractions using a single combined regex for efficiency
    for (let i = 0; i < contractions.length; i++) {
      const contraction = contractions[i];
      const regex = new RegExp(`\\b${escapeRegex(contraction)}\\b`, 'gi');
      let match;
      while ((match = regex.exec(text)) !== null) {
        violations.push(
          createViolation(
            'constraints.contractions',
            severity,
            message,
            match[0],
            { start: match.index, end: match.index + match[0].length },
            expanded[i]
          )
        );
      }
    }
  } else if (rule === 'required' || rule === 'encouraged') {
    // 'required' = info, 'encouraged' = info (both suggest using contractions)
    const message = rule === 'required'
      ? 'Use contractions for a more natural tone'
      : 'Consider using contractions for a friendlier tone';
    // Check for expanded forms that should be contracted
    for (let i = 0; i < expanded.length; i++) {
      const exp = expanded[i];
      const regex = new RegExp(`\\b${escapeRegex(exp)}\\b`, 'gi');
      let match;
      while ((match = regex.exec(text)) !== null) {
        violations.push(
          createViolation(
            'constraints.contractions',
            'info',
            message,
            match[0],
            { start: match.index, end: match.index + match[0].length },
            contractions[i]
          )
        );
      }
    }
  }

  return violations;
}

/**
 * Check Oxford comma usage
 */
function checkOxfordComma(text: string, required: boolean): Violation[] {
  const violations: Violation[] = [];

  // Pattern for lists: "X, Y and Z" or "X, Y, and Z"
  // With Oxford comma: item, item, and item
  // Without Oxford comma: item, item and item

  if (required) {
    // Look for missing Oxford comma: "X, Y and Z"
    const missingOxfordRegex = /(\w+),\s+(\w+)\s+and\s+(\w+)/gi;
    let match;
    while ((match = missingOxfordRegex.exec(text)) !== null) {
      // Check if there's no comma before "and"
      const beforeAnd = match[0].lastIndexOf(',');
      const andPos = match[0].toLowerCase().lastIndexOf(' and ');
      if (beforeAnd < andPos - 5) {
        // Likely missing Oxford comma
        violations.push(
          createViolation(
            'constraints.oxfordComma',
            'info',
            'Use the Oxford comma before "and" in lists',
            match[0],
            { start: match.index, end: match.index + match[0].length },
            `${match[1]}, ${match[2]}, and ${match[3]}`
          )
        );
      }
    }
  }

  return violations;
}

// Utility functions (createViolation, escapeRegex) imported from ../utils.js
