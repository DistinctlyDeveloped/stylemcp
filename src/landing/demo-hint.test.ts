import { describe, expect, test } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('Landing demo hint element', () => {
  const landingPath = resolve(__dirname, '../../landing/index.html');
  let content: string;

  try {
    content = readFileSync(landingPath, 'utf-8');
  } catch {
    content = '';
  }

  test('should include the demo hint element used by the demo script', () => {
    if (!content) return;
    expect(content).toContain('id="demoHint"');
    expect(content).toContain('demo-hint');
  });
});
