import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import {
  Pack,
  PackManifest,
  PackManifestSchema,
  VoiceSchema,
  CopyPatternsSchema,
  CTARulesSchema,
  TokensSchema,
  TestSuiteSchema,
  Voice,
  CopyPatterns,
  CTARules,
  Tokens,
  TestSuite,
} from '../schema/index.js';

export interface LoadPackOptions {
  packPath: string;
}

export interface PackLoadResult {
  pack: Pack;
  errors: string[];
}

async function loadYamlFile<T>(filePath: string, schema: { parse: (data: unknown) => T }): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  const data = yaml.load(content);
  return schema.parse(data);
}

async function loadJsonFile<T>(filePath: string, schema: { parse: (data: unknown) => T }): Promise<T> {
  const content = await readFile(filePath, 'utf-8');
  const data = JSON.parse(content);
  return schema.parse(data);
}

export async function loadPack(options: LoadPackOptions): Promise<PackLoadResult> {
  const { packPath } = options;
  const errors: string[] = [];

  // Load manifest
  const manifestPath = join(packPath, 'manifest.yaml');
  let manifest: PackManifest;
  try {
    manifest = await loadYamlFile(manifestPath, PackManifestSchema);
  } catch (err) {
    throw new Error(`Failed to load manifest: ${err instanceof Error ? err.message : err}`);
  }

  const files = manifest.files;

  // Load each component
  let voice: Voice;
  let copyPatterns: CopyPatterns;
  let ctaRules: CTARules;
  let tokens: Tokens;
  let tests: TestSuite;

  try {
    voice = await loadYamlFile(join(packPath, files.voice), VoiceSchema);
  } catch (err) {
    errors.push(`Failed to load voice: ${err instanceof Error ? err.message : err}`);
    voice = VoiceSchema.parse({ name: 'default', tone: { attributes: [] }, vocabulary: { rules: [] } });
  }

  try {
    copyPatterns = await loadYamlFile(join(packPath, files.copyPatterns), CopyPatternsSchema);
  } catch (err) {
    errors.push(`Failed to load copy patterns: ${err instanceof Error ? err.message : err}`);
    copyPatterns = CopyPatternsSchema.parse({ name: 'default', patterns: [] });
  }

  try {
    ctaRules = await loadYamlFile(join(packPath, files.ctaRules), CTARulesSchema);
  } catch (err) {
    errors.push(`Failed to load CTA rules: ${err instanceof Error ? err.message : err}`);
    ctaRules = CTARulesSchema.parse({ name: 'default', categories: [] });
  }

  try {
    tokens = await loadJsonFile(join(packPath, files.tokens), TokensSchema);
  } catch (err) {
    errors.push(`Failed to load tokens: ${err instanceof Error ? err.message : err}`);
    tokens = TokensSchema.parse({ name: 'default' });
  }

  try {
    tests = await loadYamlFile(join(packPath, files.tests), TestSuiteSchema);
  } catch (err) {
    errors.push(`Failed to load tests: ${err instanceof Error ? err.message : err}`);
    tests = TestSuiteSchema.parse({ name: 'default', tests: [] });
  }

  return {
    pack: {
      manifest,
      voice,
      copyPatterns,
      ctaRules,
      tokens,
      tests,
    },
    errors,
  };
}

export function getPacksDirectory(): string {
  // Get the packs directory relative to this file
  const currentDir = dirname(fileURLToPath(import.meta.url));
  return join(currentDir, '..', '..', 'packs');
}

export async function listAvailablePacks(): Promise<string[]> {
  const { readdir } = await import('fs/promises');
  const packsDir = getPacksDirectory();
  try {
    const entries = await readdir(packsDir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch {
    return [];
  }
}
