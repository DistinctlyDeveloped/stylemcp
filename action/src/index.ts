import * as core from '@actions/core';
import * as github from '@actions/github';
import { glob } from 'glob';
import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';

// Import from built dist (these get bundled by ncc)
import { validate } from '../../dist/validator/index.js';
import { ValidationResult, Violation, Pack } from '../../dist/schema/index.js';
import { loadPack, getPacksDirectory } from '../../dist/utils/pack-loader.js';

interface FileResult {
  file: string;
  result: ValidationResult;
}

async function run(): Promise<void> {
  try {
    // Get inputs
    const packName = core.getInput('pack') || 'saas';
    const filesPattern = core.getInput('files');
    const directText = core.getInput('text');
    const minScore = parseInt(core.getInput('min-score') || '70', 10);
    const strict = core.getInput('strict') === 'true';
    const failOnWarning = core.getInput('fail-on-warning') === 'true';
    const contentType = core.getInput('content-type') as any;
    const commentOnPr = core.getInput('comment-on-pr') === 'true';
    const githubToken = core.getInput('github-token');

    // Load pack
    core.info(`Loading style pack: ${packName}`);
    let pack: Pack;

    try {
      // Try loading as built-in pack first
      const packPath = join(getPacksDirectory(), packName);
      const result = await loadPack({ packPath });
      pack = result.pack;

      if (result.errors.length > 0) {
        core.warning(`Pack loading warnings: ${result.errors.join(', ')}`);
      }
    } catch {
      // Try loading as custom pack path
      const result = await loadPack({ packPath: packName });
      pack = result.pack;
    }

    core.info(`Loaded pack: ${pack.manifest.name} v${pack.manifest.version}`);

    // Collect text to validate
    const fileResults: FileResult[] = [];
    let directResult: ValidationResult | null = null;

    // Validate files
    if (filesPattern) {
      const files = await glob(filesPattern, { nodir: true });
      core.info(`Found ${files.length} files matching pattern: ${filesPattern}`);

      for (const file of files) {
        const content = await readFile(file, 'utf-8');

        // Extract text content based on file type
        const textContent = extractTextContent(file, content);

        if (textContent) {
          const result = validate({
            pack,
            text: textContent,
            context: { type: contentType },
          });

          fileResults.push({ file, result });
        }
      }
    }

    // Validate direct text
    if (directText) {
      directResult = validate({
        pack,
        text: directText,
        context: { type: contentType },
      });
    }

    // Aggregate results
    const allResults = [
      ...fileResults.map(fr => fr.result),
      ...(directResult ? [directResult] : []),
    ];

    if (allResults.length === 0) {
      core.warning('No text found to validate');
      core.setOutput('score', 100);
      core.setOutput('valid', true);
      core.setOutput('violations', 0);
      return;
    }

    // Calculate overall metrics
    const avgScore = Math.round(
      allResults.reduce((sum, r) => sum + r.score, 0) / allResults.length
    );
    const totalViolations = allResults.reduce((sum, r) => sum + r.violations.length, 0);
    const totalErrors = allResults.reduce((sum, r) => sum + r.summary.errors, 0);
    const totalWarnings = allResults.reduce((sum, r) => sum + r.summary.warnings, 0);

    // Determine pass/fail
    let valid = avgScore >= minScore && totalErrors === 0;
    if (strict && totalViolations > 0) {
      valid = false;
    }
    if (failOnWarning && totalWarnings > 0) {
      valid = false;
    }

    // Set outputs
    core.setOutput('score', avgScore);
    core.setOutput('valid', valid);
    core.setOutput('violations', totalViolations);
    core.setOutput('report', JSON.stringify({
      score: avgScore,
      valid,
      totalViolations,
      totalErrors,
      totalWarnings,
      files: fileResults.map(fr => ({
        file: fr.file,
        score: fr.result.score,
        violations: fr.result.violations.length,
      })),
    }));

    // Log summary
    core.info('');
    core.info('=== StyleMCP Validation Results ===');
    core.info(`Score: ${avgScore}/100`);
    core.info(`Violations: ${totalViolations} (${totalErrors} errors, ${totalWarnings} warnings)`);
    core.info(`Status: ${valid ? 'PASS' : 'FAIL'}`);
    core.info('');

    // Log file results
    if (fileResults.length > 0) {
      core.info('File Results:');
      for (const { file, result } of fileResults) {
        const status = result.valid ? '✓' : '✗';
        core.info(`  ${status} ${file}: ${result.score}/100 (${result.violations.length} violations)`);
      }
      core.info('');
    }

    // Log violations
    if (totalViolations > 0) {
      core.info('Violations:');
      for (const { file, result } of fileResults) {
        for (const violation of result.violations) {
          const icon = violation.severity === 'error' ? '❌' : violation.severity === 'warning' ? '⚠️' : 'ℹ️';
          core.info(`  ${icon} [${file}] ${violation.message}`);
          if (violation.text) {
            core.info(`     Text: "${violation.text}"`);
          }
          if (violation.suggestion) {
            core.info(`     Suggestion: ${violation.suggestion}`);
          }
        }
      }

      if (directResult) {
        for (const violation of directResult.violations) {
          const icon = violation.severity === 'error' ? '❌' : violation.severity === 'warning' ? '⚠️' : 'ℹ️';
          core.info(`  ${icon} ${violation.message}`);
        }
      }
    }

    // Post PR comment if enabled
    if (commentOnPr && github.context.payload.pull_request && githubToken) {
      await postPrComment(githubToken, {
        score: avgScore,
        valid,
        totalViolations,
        totalErrors,
        totalWarnings,
        fileResults,
        directResult,
        packName: pack.manifest.name,
        packVersion: pack.manifest.version,
      });
    }

    // Fail the action if validation failed
    if (!valid) {
      core.setFailed(`StyleMCP validation failed. Score: ${avgScore}/100, Violations: ${totalViolations}`);
    }
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : 'Unknown error');
  }
}

/**
 * Extract text content from files based on type
 */
function extractTextContent(file: string, content: string): string | null {
  const ext = file.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'md':
    case 'mdx':
      // Return markdown content as-is
      return content;

    case 'json':
      // Try to extract string values
      try {
        const obj = JSON.parse(content);
        return extractStringsFromObject(obj).join('\n');
      } catch {
        return null;
      }

    case 'yaml':
    case 'yml':
      // Try to extract string values
      try {
        const obj = yaml.load(content);
        return extractStringsFromObject(obj).join('\n');
      } catch {
        return null;
      }

    case 'tsx':
    case 'jsx':
      // Extract string literals from JSX
      return extractJsxStrings(content);

    case 'ts':
    case 'js':
      // Extract string literals
      return extractJsStrings(content);

    case 'txt':
      return content;

    default:
      // Try to extract any quoted strings
      return extractQuotedStrings(content);
  }
}

/**
 * Extract string values from an object recursively
 */
function extractStringsFromObject(obj: any, strings: string[] = []): string[] {
  if (typeof obj === 'string' && obj.length > 3) {
    strings.push(obj);
  } else if (Array.isArray(obj)) {
    for (const item of obj) {
      extractStringsFromObject(item, strings);
    }
  } else if (obj && typeof obj === 'object') {
    for (const value of Object.values(obj)) {
      extractStringsFromObject(value, strings);
    }
  }
  return strings;
}

/**
 * Extract string literals from JSX/TSX
 */
function extractJsxStrings(content: string): string {
  const strings: string[] = [];

  // Match JSX text content between tags
  const jsxTextRegex = />([^<>{]+)</g;
  let match;
  while ((match = jsxTextRegex.exec(content)) !== null) {
    const text = match[1].trim();
    if (text.length > 3 && !text.startsWith('{')) {
      strings.push(text);
    }
  }

  // Match string literals in props
  const propRegex = /=["']([^"']+)["']/g;
  while ((match = propRegex.exec(content)) !== null) {
    const text = match[1].trim();
    if (text.length > 3) {
      strings.push(text);
    }
  }

  return strings.join('\n');
}

/**
 * Extract string literals from JS/TS
 */
function extractJsStrings(content: string): string {
  const strings: string[] = [];

  // Match template literals
  const templateRegex = /`([^`]+)`/g;
  let match;
  while ((match = templateRegex.exec(content)) !== null) {
    const text = match[1].trim();
    if (text.length > 10 && !text.includes('${')) {
      strings.push(text);
    }
  }

  // Match regular string literals (longer ones likely to be user-facing)
  const stringRegex = /["']([^"'\n]{20,})["']/g;
  while ((match = stringRegex.exec(content)) !== null) {
    strings.push(match[1]);
  }

  return strings.join('\n');
}

/**
 * Extract any quoted strings
 */
function extractQuotedStrings(content: string): string {
  const strings: string[] = [];
  const regex = /["']([^"'\n]{10,})["']/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    strings.push(match[1]);
  }
  return strings.join('\n');
}

/**
 * Post a comment on the PR with validation results
 */
async function postPrComment(
  token: string,
  data: {
    score: number;
    valid: boolean;
    totalViolations: number;
    totalErrors: number;
    totalWarnings: number;
    fileResults: FileResult[];
    directResult: ValidationResult | null;
    packName: string;
    packVersion: string;
  }
): Promise<void> {
  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;
  const pullNumber = github.context.payload.pull_request!.number;

  const statusIcon = data.valid ? '✅' : '❌';
  const scoreColor = data.score >= 80 ? '🟢' : data.score >= 60 ? '🟡' : '🔴';

  let body = `## ${statusIcon} StyleMCP Validation

${scoreColor} **Score: ${data.score}/100**

| Metric | Count |
|--------|-------|
| Total Violations | ${data.totalViolations} |
| Errors | ${data.totalErrors} |
| Warnings | ${data.totalWarnings} |

`;

  if (data.fileResults.length > 0) {
    body += `### Files Checked

| File | Score | Violations |
|------|-------|------------|
`;
    for (const { file, result } of data.fileResults) {
      const icon = result.valid ? '✓' : '✗';
      body += `| ${icon} ${file} | ${result.score} | ${result.violations.length} |\n`;
    }
    body += '\n';
  }

  if (data.totalViolations > 0) {
    body += `### Violations

`;
    const allViolations: { file?: string; violation: Violation }[] = [];

    for (const { file, result } of data.fileResults) {
      for (const violation of result.violations) {
        allViolations.push({ file, violation });
      }
    }

    if (data.directResult) {
      for (const violation of data.directResult.violations) {
        allViolations.push({ violation });
      }
    }

    // Show top 10 violations
    for (const { file, violation } of allViolations.slice(0, 10)) {
      const icon = violation.severity === 'error' ? '🔴' : violation.severity === 'warning' ? '🟡' : '🔵';
      body += `${icon} **${violation.message}**\n`;
      if (file) {
        body += `   📁 ${file}\n`;
      }
      if (violation.text) {
        body += `   > "${violation.text}"\n`;
      }
      if (violation.suggestion) {
        body += `   💡 ${violation.suggestion}\n`;
      }
      body += '\n';
    }

    if (allViolations.length > 10) {
      body += `\n_...and ${allViolations.length - 10} more violations_\n`;
    }
  }

  body += `\n---\n_Validated with [StyleMCP](https://stylemcp.com) pack: ${data.packName} v${data.packVersion}_`;

  // Check for existing comment to update
  const comments = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: pullNumber,
  });

  const existingComment = comments.data.find(
    comment => comment.body?.includes('## ') && comment.body?.includes('StyleMCP Validation')
  );

  if (existingComment) {
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existingComment.id,
      body,
    });
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }
}

run();
