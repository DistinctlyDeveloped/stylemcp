import { readFile, stat } from 'fs/promises';
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
  /** Skip cache and force reload from disk */
  noCache?: boolean;
}

export interface PackLoadResult {
  pack: Pack;
  errors: string[];
  /** Whether the result was served from cache */
  cached?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pack Cache - reduces disk I/O for repeated validations
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  result: PackLoadResult;
  manifestMtime: number;
  cachedAt: number;
}

const CACHE_TTL_MS = 60_000; // 1 minute
const CACHE_MAX_SIZE = 20;
const packCache = new Map<string, CacheEntry>();

async function getManifestMtime(packPath: string): Promise<number> {
  try {
    const manifestPath = join(packPath, 'manifest.yaml');
    const stats = await stat(manifestPath);
    return stats.mtimeMs;
  } catch {
    return 0;
  }
}

function isCacheValid(entry: CacheEntry, currentMtime: number): boolean {
  const now = Date.now();
  const age = now - entry.cachedAt;
  // Invalid if TTL expired or manifest was modified
  return age < CACHE_TTL_MS && entry.manifestMtime === currentMtime;
}

function pruneCache(): void {
  if (packCache.size <= CACHE_MAX_SIZE) return;
  // Remove oldest entries (FIFO - Map maintains insertion order)
  const excess = packCache.size - CACHE_MAX_SIZE;
  const keys = Array.from(packCache.keys()).slice(0, excess);
  keys.forEach(k => packCache.delete(k));
}

/** Clear the pack cache (useful for testing or after file changes) */
export function clearPackCache(): void {
  packCache.clear();
}

/** Get cache stats for monitoring */
export function getPackCacheStats(): { size: number; maxSize: number; ttlMs: number } {
  return { size: packCache.size, maxSize: CACHE_MAX_SIZE, ttlMs: CACHE_TTL_MS };
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
  const { packPath, noCache } = options;
  const errors: string[] = [];

  // Check cache first (unless noCache is set)
  if (!noCache) {
    const cached = packCache.get(packPath);
    if (cached) {
      const currentMtime = await getManifestMtime(packPath);
      if (isCacheValid(cached, currentMtime)) {
        return { ...cached.result, cached: true };
      }
      // Cache invalid, remove stale entry
      packCache.delete(packPath);
    }
  }

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

  const result: PackLoadResult = {
    pack: {
      manifest,
      voice,
      copyPatterns,
      ctaRules,
      tokens,
      tests,
    },
    errors,
    cached: false,
  };

  // Cache the result
  const manifestMtime = await getManifestMtime(packPath);
  packCache.set(packPath, {
    result,
    manifestMtime,
    cachedAt: Date.now(),
  });
  pruneCache();

  return result;
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
