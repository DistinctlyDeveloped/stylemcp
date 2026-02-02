import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { getPacksDirectory } from '../utils/pack-loader.js';

export interface VoiceSample {
  text: string;
  source?: string;
  context?: 'email' | 'blog' | 'social' | 'marketing' | 'support' | 'other';
}

export interface VoiceProfile {
  tone: {
    summary: string;
    attributes: Array<{ name: string; weight: number }>;
  };
  vocabulary: {
    rules: Array<{ preferred: string; avoid: string[] }>;
    forbidden: string[];
  };
  patterns: Array<{
    pattern: string;
    reason: string;
    severity: 'error' | 'warning' | 'info';
    isRegex?: boolean;
  }>;
  ctaStyle: {
    maxWords: number;
    preferredStyle: 'action' | 'descriptive' | 'conversational';
    avoidWords: string[];
  };
}

export interface LearnVoiceOptions {
  samples: VoiceSample[];
  packName: string;
  basePackName?: string; // Pack to use as starting point
  outputPath?: string;
}

export interface VoiceAnalysisResult {
  profile: VoiceProfile;
  confidence: number; // 0-100
  sampleCount: number;
  recommendations: string[];
}

/**
 * Analyze writing samples to generate a voice profile
 */
export class VoiceAnalyzer {
  private readonly commonWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 
    'of', 'with', 'by', 'from', 'up', 'about', 'into', 'through', 'during',
    'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had',
    'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
    'can', 'must', 'shall', 'this', 'that', 'these', 'those', 'i', 'you',
    'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them'
  ]);

  /**
   * Analyze writing samples and generate a voice profile
   */
  async analyze(samples: VoiceSample[]): Promise<VoiceAnalysisResult> {
    if (samples.length === 0) {
      throw new Error('At least one sample is required');
    }

    const combinedText = samples.map(s => s.text).join(' ');
    const sentences = this.splitSentences(combinedText);
    
    // Analyze tone attributes
    const toneAttributes = this.analyzeTone(sentences);
    
    // Analyze vocabulary patterns
    const vocabularyAnalysis = this.analyzeVocabulary(sentences);
    
    // Analyze CTA style (if samples contain CTAs)
    const ctaAnalysis = this.analyzeCTAs(sentences);
    
    // Detect problematic patterns
    const patterns = this.detectPatterns(sentences);

    const profile: VoiceProfile = {
      tone: {
        summary: this.generateToneSummary(toneAttributes),
        attributes: toneAttributes
      },
      vocabulary: {
        rules: vocabularyAnalysis.rules,
        forbidden: vocabularyAnalysis.forbidden
      },
      patterns: patterns,
      ctaStyle: ctaAnalysis
    };

    // Calculate confidence based on sample size and consistency
    const confidence = this.calculateConfidence(samples.length, sentences.length);
    
    const recommendations = this.generateRecommendations(profile, samples.length);

    return {
      profile,
      confidence,
      sampleCount: samples.length,
      recommendations
    };
  }

  private splitSentences(text: string): string[] {
    // Simple sentence splitting - could be enhanced with NLP library
    return text
      .split(/[.!?]+/)
      .map(s => s.trim())
      .filter(s => s.length > 3);
  }

  private analyzeTone(sentences: string[]): Array<{ name: string; weight: number }> {
    const indicators = {
      professional: [/\b(utilize|implement|execute|facilitate|optimize)\b/gi, /\b(leverage|synergy|paradigm)\b/gi],
      friendly: [/\b(hi|hey|thanks|appreciate|love)\b/gi, /[!]{1,2}(?![!])/g, /\b(awesome|great|amazing)\b/gi],
      formal: [/\b(therefore|furthermore|consequently|nevertheless)\b/gi, /\b(shall|pursuant|hereby)\b/gi],
      casual: [/\b(gonna|wanna|kinda|sorta)\b/gi, /\b(cool|neat|sweet)\b/gi],
      helpful: [/\b(help|assist|support|guide|show)\b/gi, /\blet me\b/gi],
      confident: [/\b(will|definitely|certainly|ensure)\b/gi, /\b(we can|you can)\b/gi],
      empathetic: [/\b(understand|sorry|apologize|realize)\b/gi, /\b(I know|we know)\b/gi]
    };

    const combinedText = sentences.join(' ').toLowerCase();
    const attributes: Array<{ name: string; weight: number }> = [];

    for (const [tone, patterns] of Object.entries(indicators)) {
      let matches = 0;
      for (const pattern of patterns) {
        const found = combinedText.match(pattern);
        if (found) matches += found.length;
      }
      
      // Weight based on frequency relative to text length
      const weight = Math.min(1.0, (matches / sentences.length) * 2);
      if (weight > 0.1) {
        attributes.push({ name: tone, weight: Math.round(weight * 100) / 100 });
      }
    }

    return attributes.sort((a, b) => b.weight - a.weight).slice(0, 5);
  }

  private analyzeVocabulary(sentences: string[]): { rules: Array<{ preferred: string; avoid: string[] }>; forbidden: string[] } {
    const combinedText = sentences.join(' ').toLowerCase();
    
    // Common word substitutions we can detect
    const substitutionPatterns = [
      { complex: 'utilize', simple: 'use' },
      { complex: 'facilitate', simple: 'help' },
      { complex: 'implement', simple: 'do' },
      { complex: 'commence', simple: 'start' },
      { complex: 'terminate', simple: 'end' },
      { complex: 'demonstrate', simple: 'show' },
      { complex: 'acquire', simple: 'get' },
      { complex: 'assist', simple: 'help' }
    ];

    const rules: Array<{ preferred: string; avoid: string[] }> = [];
    const forbidden: string[] = [];

    // Check for overused complex words
    for (const { complex, simple } of substitutionPatterns) {
      const complexCount = (combinedText.match(new RegExp(`\\b${complex}\\b`, 'g')) || []).length;
      const simpleCount = (combinedText.match(new RegExp(`\\b${simple}\\b`, 'g')) || []).length;
      
      if (complexCount > 0 && simpleCount === 0) {
        // They use complex but not simple - suggest the simpler version
        rules.push({ preferred: simple, avoid: [complex] });
      }
    }

    // Common jargon to flag
    const jargonWords = [
      'synergy', 'leverage', 'paradigm', 'disruptive', 'innovative',
      'cutting-edge', 'game-changing', 'best-in-class', 'world-class',
      'leading-edge', 'state-of-the-art'
    ];

    for (const jargon of jargonWords) {
      if (combinedText.includes(jargon)) {
        forbidden.push(jargon);
      }
    }

    return { rules, forbidden };
  }

  private analyzeCTAs(sentences: string[]): {
    maxWords: number;
    preferredStyle: 'action' | 'descriptive' | 'conversational';
    avoidWords: string[];
  } {
    // Look for button-like text (simple heuristic)
    const potentialCTAs = sentences.filter(s => {
      const lower = s.toLowerCase().trim();
      return (
        s.length < 50 && // Short
        (lower.startsWith('click') || lower.startsWith('get') || 
         lower.startsWith('start') || lower.startsWith('sign') ||
         lower.startsWith('try') || lower.startsWith('learn') ||
         lower.includes('now') || lower.includes('today'))
      );
    });

    let maxWords = 4;
    let preferredStyle: 'action' | 'descriptive' | 'conversational' = 'action';
    const avoidWords: string[] = [];

    if (potentialCTAs.length > 0) {
      const avgLength = potentialCTAs.reduce((sum, cta) => sum + cta.split(' ').length, 0) / potentialCTAs.length;
      maxWords = Math.ceil(avgLength);

      // Detect style patterns
      const hasPersonalPronouns = potentialCTAs.some(cta => /\b(your|you|my|our)\b/i.test(cta));
      const hasDescriptiveWords = potentialCTAs.some(cta => /\b(learn|discover|explore|find out)\b/i.test(cta));
      const hasGenericWords = potentialCTAs.some(cta => /\b(click here|submit|ok|yes|no)\b/i.test(cta));

      if (hasGenericWords) {
        avoidWords.push('click here', 'submit', 'ok');
      }

      if (hasPersonalPronouns && hasDescriptiveWords) {
        preferredStyle = 'conversational';
      } else if (hasDescriptiveWords) {
        preferredStyle = 'descriptive';
      }
    }

    return { maxWords, preferredStyle, avoidWords };
  }

  private detectPatterns(sentences: string[]): Array<{
    pattern: string;
    reason: string;
    severity: 'error' | 'warning' | 'info';
    isRegex?: boolean;
  }> {
    const patterns: Array<{
      pattern: string;
      reason: string;
      severity: 'error' | 'warning' | 'info';
      isRegex?: boolean;
    }> = [];

    const combinedText = sentences.join(' ');

    // Common anti-patterns to detect
    const antiPatterns = [
      { pattern: 'click here', reason: 'Poor accessibility - describe destination instead', severity: 'error' as const },
      { pattern: 'sorry for any inconvenience', reason: 'Corporate non-apology - lead with solutions', severity: 'warning' as const },
      { pattern: '\\b(obviously|simply|just)\\b', reason: 'Can make users feel stupid', severity: 'warning' as const, isRegex: true },
      { pattern: 'please please', reason: 'Sounds desperate - use one "please"', severity: 'warning' as const },
      { pattern: 'very very', reason: 'Redundant intensifiers weaken your message', severity: 'info' as const }
    ];

    for (const antiPattern of antiPatterns) {
      const regex = antiPattern.isRegex 
        ? new RegExp(antiPattern.pattern, 'gi')
        : new RegExp(`\\b${antiPattern.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      
      if (regex.test(combinedText)) {
        patterns.push(antiPattern);
      }
    }

    return patterns;
  }

  private generateToneSummary(attributes: Array<{ name: string; weight: number }>): string {
    if (attributes.length === 0) return 'Neutral and balanced';
    
    const topAttributes = attributes.slice(0, 3).map(a => a.name);
    
    if (topAttributes.length === 1) {
      return `${topAttributes[0].charAt(0).toUpperCase() + topAttributes[0].slice(1)} tone`;
    } else if (topAttributes.length === 2) {
      return `${topAttributes[0].charAt(0).toUpperCase() + topAttributes[0].slice(1)} and ${topAttributes[1]}`;
    } else {
      const last = topAttributes.pop()!;
      return `${topAttributes.map(t => t.charAt(0).toUpperCase() + t.slice(1)).join(', ')}, and ${last}`;
    }
  }

  private calculateConfidence(sampleCount: number, sentenceCount: number): number {
    // Base confidence on sample diversity and volume
    const sampleScore = Math.min(100, (sampleCount / 10) * 50); // Up to 50 points for samples
    const volumeScore = Math.min(50, (sentenceCount / 100) * 50); // Up to 50 points for volume
    
    return Math.round(sampleScore + volumeScore);
  }

  private generateRecommendations(profile: VoiceProfile, sampleCount: number): string[] {
    const recommendations: string[] = [];
    
    if (sampleCount < 5) {
      recommendations.push('Add more samples (5-10) for better accuracy');
    }
    
    if (profile.tone.attributes.length === 0) {
      recommendations.push('Include more varied content to detect tone patterns');
    }
    
    if (profile.patterns.length === 0) {
      recommendations.push('Your writing is clean! No problematic patterns detected');
    }
    
    if (profile.vocabulary.forbidden.length > 3) {
      recommendations.push('Consider reducing jargon usage for broader accessibility');
    }
    
    return recommendations;
  }

  /**
   * Generate a complete style pack from voice analysis
   */
  async generatePack(options: LearnVoiceOptions): Promise<void> {
    const analysis = await this.analyze(options.samples);
    const packPath = options.outputPath || join(getPacksDirectory(), options.packName);

    // Create pack directory
    await mkdir(packPath, { recursive: true });

    // Generate manifest.yaml
    const manifest = {
      name: options.packName,
      version: '1.0.0',
      description: `Auto-generated pack from ${analysis.sampleCount} samples (${analysis.confidence}% confidence)`,
      author: 'StyleMCP Voice Learning',
      files: {
        voice: 'voice.yaml',
        copyPatterns: 'copy_patterns.yaml',
        ctaRules: 'cta_rules.yaml',
        tokens: 'tokens.json',
        tests: 'tests.yaml'
      }
    };

    await writeFile(
      join(packPath, 'manifest.yaml'),
      `# Auto-generated by StyleMCP Voice Learning\n# Confidence: ${analysis.confidence}%\n# Samples: ${analysis.sampleCount}\n\n` +
      this.yamlStringify(manifest)
    );

    // Generate voice.yaml
    const voice = {
      name: options.packName,
      ...analysis.profile.tone,
      vocabulary: analysis.profile.vocabulary,
      doNot: analysis.profile.patterns
    };

    await writeFile(
      join(packPath, 'voice.yaml'),
      `# Voice profile generated from ${analysis.sampleCount} samples\n# Confidence: ${analysis.confidence}%\n\n` +
      this.yamlStringify(voice)
    );

    // Generate basic CTA rules
    const ctaRules = {
      name: options.packName,
      categories: [
        {
          name: 'primary',
          maxWords: analysis.profile.ctaStyle.maxWords,
          style: analysis.profile.ctaStyle.preferredStyle,
          forbidden: analysis.profile.ctaStyle.avoidWords
        }
      ]
    };

    await writeFile(
      join(packPath, 'cta_rules.yaml'),
      this.yamlStringify(ctaRules)
    );

    // Generate empty copy patterns and tests
    await writeFile(
      join(packPath, 'copy_patterns.yaml'),
      this.yamlStringify({ name: options.packName, patterns: [] })
    );

    await writeFile(
      join(packPath, 'tests.yaml'),
      this.yamlStringify({ name: options.packName, tests: [] })
    );

    await writeFile(
      join(packPath, 'tokens.json'),
      JSON.stringify({ name: options.packName }, null, 2)
    );

    // Create README
    const readme = `# ${options.packName}

Auto-generated style pack from ${analysis.sampleCount} writing samples.

**Confidence:** ${analysis.confidence}%

## Detected Tone
${analysis.profile.tone.summary}

Key attributes:
${analysis.profile.tone.attributes.map(a => `- ${a.name}: ${a.weight}`).join('\n')}

## Recommendations
${analysis.recommendations.map(r => `- ${r}`).join('\n')}

## Usage

\`\`\`bash
# Validate with this pack
stylemcp validate "Your text here" --pack ${options.packName}

# Use in API
curl -X POST https://stylemcp.com/api/validate \\
  -d '{"text": "Your text", "pack": "${options.packName}"}'
\`\`\`
`;

    await writeFile(join(packPath, 'README.md'), readme);
  }

  private yamlStringify(obj: any): string {
    // Simple YAML stringifier - could use js-yaml for more complex objects
    return JSON.stringify(obj, null, 2)
      .replace(/"/g, '')
      .replace(/,$/gm, '')
      .replace(/{/g, '')
      .replace(/}/g, '')
      .replace(/^\s*\[/gm, '  -')
      .replace(/\]/g, '');
  }
}