/**
 * Shared utilities for validator rules
 */

import { randomUUID } from 'crypto';
import { Violation } from '../schema/index.js';

/**
 * Create a violation object with consistent structure
 */
export function createViolation(
  rule: string,
  severity: 'error' | 'warning' | 'info',
  message: string,
  text?: string,
  position?: { start: number; end: number },
  suggestion?: string
): Violation {
  return {
    id: `v-${randomUUID().slice(0, 8)}`,
    rule,
    severity,
    message,
    text,
    position,
    suggestion,
  };
}

/**
 * Escape special regex characters in a string
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert string to slug for rule IDs
 */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
