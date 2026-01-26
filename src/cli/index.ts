#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { loadPack, getPacksDirectory, listAvailablePacks } from '../utils/pack-loader.js';
import { validate } from '../validator/index.js';
import { rewrite, formatChanges, generateDiff } from '../rewriter/index.js';
import { Pack, ValidationResult, Violation } from '../schema/index.js';

const program = new Command();

program
  .name('stylemcp')
  .description('Executable brand rules for models and agents')
  .version('0.1.4');

/**
 * Validate command
 */
program
  .command('validate')
  .description('Validate text against style rules')
  .argument('[text]', 'Text to validate (or use --file)')
  .option('-f, --file <path>', 'Read text from file')
  .option('-p, --pack <name>', 'Style pack to use', 'saas')
  .option('-t, --type <type>', 'Content type (ui-copy, marketing, docs, support, general)')
  .option('--json', 'Output as JSON')
  .option('--strict', 'Fail on any violation')
  .action(async (text, options) => {
    try {
      // Get text from argument or file
      let inputText = text;
      if (options.file) {
        inputText = await readFile(options.file, 'utf-8');
      }

      if (!inputText) {
        console.error(chalk.red('Error: No text provided. Use argument or --file'));
        process.exit(1);
      }

      // Load pack
      const packPath = join(getPacksDirectory(), options.pack);
      const { pack, errors } = await loadPack({ packPath });

      if (errors.length > 0) {
        console.error(chalk.yellow('Pack warnings:'), errors.join(', '));
      }

      // Validate
      const result = validate({
        pack,
        text: inputText,
        context: options.type ? { type: options.type } : undefined,
      });

      // Output
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printValidationResult(result);
      }

      // Exit code
      const shouldFail = options.strict ? !result.valid || result.violations.length > 0 : !result.valid;
      process.exit(shouldFail ? 1 : 0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Rewrite command
 */
program
  .command('rewrite')
  .description('Rewrite text to conform to style rules')
  .argument('[text]', 'Text to rewrite (or use --file)')
  .option('-f, --file <path>', 'Read text from file')
  .option('-p, --pack <name>', 'Style pack to use', 'saas')
  .option('-m, --mode <mode>', 'Rewrite mode (minimal, normal, aggressive)', 'normal')
  .option('-t, --type <type>', 'Content type (ui-copy, marketing, docs, support, general)')
  .option('--json', 'Output as JSON')
  .option('--diff', 'Show diff format')
  .option('--changes-only', 'Only show changes, not full text')
  .action(async (text, options) => {
    try {
      let inputText = text;
      if (options.file) {
        inputText = await readFile(options.file, 'utf-8');
      }

      if (!inputText) {
        console.error(chalk.red('Error: No text provided. Use argument or --file'));
        process.exit(1);
      }

      const packPath = join(getPacksDirectory(), options.pack);
      const { pack, errors } = await loadPack({ packPath });

      if (errors.length > 0) {
        console.error(chalk.yellow('Pack warnings:'), errors.join(', '));
      }

      const result = rewrite({
        pack,
        text: inputText,
        context: options.type ? { type: options.type } : undefined,
        fixSeverity:
          options.mode === 'minimal'
            ? ['error']
            : options.mode === 'aggressive'
              ? ['error', 'warning', 'info']
              : ['error', 'warning'],
      });

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (options.diff) {
        console.log(generateDiff(result));
      } else if (options.changesOnly) {
        console.log(formatChanges(result));
      } else {
        console.log(chalk.bold('Rewritten text:'));
        console.log(result.rewritten);
        console.log();
        console.log(chalk.dim(`Score: ${result.score.before} → ${result.score.after}`));
        console.log(chalk.dim(`Changes: ${result.changes.length}`));
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Test command - run tests from a pack
 */
program
  .command('test')
  .description('Run tests from a style pack')
  .option('-p, --pack <name>', 'Style pack to use', 'saas')
  .option('--filter <pattern>', 'Filter tests by ID or tag')
  .option('--json', 'Output as JSON')
  .action(async (options) => {
    try {
      const packPath = join(getPacksDirectory(), options.pack);
      const { pack, errors } = await loadPack({ packPath });

      if (errors.length > 0) {
        console.error(chalk.yellow('Pack warnings:'), errors.join(', '));
      }

      let tests = pack.tests.tests;
      if (options.filter) {
        const filter = options.filter.toLowerCase();
        tests = tests.filter(
          t =>
            t.id.toLowerCase().includes(filter) ||
            t.tags.some(tag => tag.toLowerCase().includes(filter))
        );
      }

      const results: { test: any; passed: boolean; result: ValidationResult }[] = [];
      let passed = 0;
      let failed = 0;

      for (const test of tests) {
        const result = validate({
          pack,
          text: test.input,
          context: test.context,
        });

        // Check expectations
        let testPassed = true;

        if (test.expect.pass !== undefined) {
          testPassed = testPassed && result.valid === test.expect.pass;
        }

        if (test.expect.minScore !== undefined) {
          testPassed = testPassed && result.score >= test.expect.minScore;
        }

        if (test.expect.maxScore !== undefined) {
          testPassed = testPassed && result.score <= test.expect.maxScore;
        }

        if (test.expect.violations) {
          for (const expectedViolation of test.expect.violations) {
            const found = result.violations.some(v =>
              v.rule.includes(expectedViolation.rule) &&
              (!expectedViolation.severity || v.severity === expectedViolation.severity)
            );
            testPassed = testPassed && found;
          }
        }

        if (test.expect.noViolations) {
          for (const noViolation of test.expect.noViolations) {
            const found = result.violations.some(v => v.rule.includes(noViolation));
            testPassed = testPassed && !found;
          }
        }

        if (testPassed) {
          passed++;
        } else {
          failed++;
        }

        results.push({ test, passed: testPassed, result });
      }

      if (options.json) {
        console.log(JSON.stringify({ passed, failed, total: tests.length, results }, null, 2));
      } else {
        console.log(chalk.bold(`\nRunning ${tests.length} tests from pack "${options.pack}"...\n`));

        for (const { test, passed: testPassed, result } of results) {
          const icon = testPassed ? chalk.green('✓') : chalk.red('✗');
          const status = testPassed ? chalk.green('PASS') : chalk.red('FAIL');
          console.log(`${icon} ${test.id}: ${test.name} [${status}]`);

          if (!testPassed) {
            console.log(chalk.dim(`    Input: "${test.input.slice(0, 60)}${test.input.length > 60 ? '...' : ''}"`));
            console.log(chalk.dim(`    Score: ${result.score}, Valid: ${result.valid}`));
            if (result.violations.length > 0) {
              console.log(chalk.dim(`    Violations: ${result.violations.map(v => v.rule).join(', ')}`));
            }
          }
        }

        console.log();
        console.log(chalk.bold('Results:'));
        console.log(`  ${chalk.green(`${passed} passed`)}, ${chalk.red(`${failed} failed`)}, ${tests.length} total`);
      }

      process.exit(failed > 0 ? 1 : 0);
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * List packs command
 */
program
  .command('packs')
  .description('List available style packs')
  .action(async () => {
    try {
      const packs = await listAvailablePacks();
      console.log(chalk.bold('Available packs:'));
      for (const packName of packs) {
        console.log(`  - ${packName}`);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Inspect command - show pack details
 */
program
  .command('inspect')
  .description('Inspect a style pack')
  .option('-p, --pack <name>', 'Style pack to inspect', 'saas')
  .option('-s, --section <section>', 'Section to show (voice, patterns, ctas, tokens)')
  .action(async (options) => {
    try {
      const packPath = join(getPacksDirectory(), options.pack);
      const { pack, errors } = await loadPack({ packPath });

      if (errors.length > 0) {
        console.error(chalk.yellow('Pack warnings:'), errors.join(', '));
      }

      if (options.section) {
        switch (options.section) {
          case 'voice':
            console.log(JSON.stringify(pack.voice, null, 2));
            break;
          case 'patterns':
            console.log(JSON.stringify(pack.copyPatterns, null, 2));
            break;
          case 'ctas':
            console.log(JSON.stringify(pack.ctaRules, null, 2));
            break;
          case 'tokens':
            console.log(JSON.stringify(pack.tokens, null, 2));
            break;
          default:
            console.error(chalk.red(`Unknown section: ${options.section}`));
            process.exit(1);
        }
      } else {
        console.log(chalk.bold(`Pack: ${pack.manifest.name} v${pack.manifest.version}`));
        console.log(chalk.dim(pack.manifest.description || ''));
        console.log();
        console.log(`Voice: ${pack.voice.name}`);
        console.log(`  Tone: ${pack.voice.tone.summary || 'Not specified'}`);
        console.log(`  Vocabulary rules: ${pack.voice.vocabulary.rules.length}`);
        console.log(`  Forbidden phrases: ${pack.voice.vocabulary.forbidden.length}`);
        console.log(`  Do-not patterns: ${pack.voice.doNot.length}`);
        console.log(`  Examples: ${pack.voice.examples.length}`);
        console.log();
        console.log(`Copy patterns: ${pack.copyPatterns.patterns.length}`);
        console.log(`CTA categories: ${pack.ctaRules.categories.length}`);
        console.log(`Tests: ${pack.tests.tests.length}`);
      }
    } catch (error) {
      console.error(chalk.red('Error:'), error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

/**
 * Server command - start MCP server
 */
program
  .command('serve')
  .description('Start the MCP server (stdio)')
  .action(async () => {
    // Dynamic import to avoid loading server code for other commands
    await import('../server/index.js');
  });

/**
 * Print validation result in a readable format
 */
function printValidationResult(result: ValidationResult): void {
  const scoreColor = result.score >= 80 ? chalk.green : result.score >= 60 ? chalk.yellow : chalk.red;
  const statusIcon = result.valid ? chalk.green('✓') : chalk.red('✗');

  console.log();
  console.log(`${statusIcon} Score: ${scoreColor(result.score.toString())}/100`);
  console.log();

  if (result.violations.length === 0) {
    console.log(chalk.green('No violations found.'));
  } else {
    console.log(chalk.bold(`Violations (${result.violations.length}):`));
    console.log();

    for (const violation of result.violations) {
      const icon =
        violation.severity === 'error'
          ? chalk.red('✗')
          : violation.severity === 'warning'
            ? chalk.yellow('⚠')
            : chalk.blue('ℹ');

      console.log(`${icon} ${violation.message}`);
      if (violation.text) {
        console.log(chalk.dim(`   Text: "${violation.text}"`));
      }
      if (violation.suggestion) {
        console.log(chalk.cyan(`   Suggestion: ${violation.suggestion}`));
      }
      console.log();
    }
  }

  console.log(chalk.dim(`Pack: ${result.metadata.packName} v${result.metadata.packVersion}`));
}

program.parse();
