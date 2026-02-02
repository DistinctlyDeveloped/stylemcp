/**
 * AI Output Validation - validates AI-generated content for brand compliance
 * 
 * This addresses the 2026 trend where brands need to ensure AI assistants
 * represent them correctly and consistently across all outputs.
 */

import { validate } from '../validator/index.js';
import { VoiceContextManager } from '../utils/voice-context.js';

export interface AIOutputValidationRequest {
  /** The AI-generated content to validate */
  content: string;
  /** Style pack to validate against */
  pack?: string;
  /** Context metadata to help select appropriate pack/voice */
  context?: {
    /** Source AI system (e.g., 'chatgpt', 'claude', 'gemini') */
    aiSystem?: string;
    /** Content type (e.g., 'email', 'blog', 'social', 'support') */
    contentType?: string;
    /** Target audience */
    audience?: string;
    /** Brand or company name */
    brand?: string;
    /** Channel where content will be used */
    channel?: string;
  };
  /** Whether to include rewrite suggestions */
  includeRewrite?: boolean;
}

export interface AIOutputValidationResult {
  /** Overall brand compliance score (0-100) */
  score: number;
  /** Whether this content meets brand standards */
  compliant: boolean;
  /** Detailed validation results */
  validation: any; // From existing validator
  /** AI-specific concerns */
  aiConcerns: AIOutputConcern[];
  /** Recommended improvements */
  recommendations: string[];
  /** Context analysis */
  contextAnalysis: {
    detectedContext: string;
    confidence: number;
    selectedPack: string;
    reason: string;
  };
  /** Rewritten content (if requested) */
  rewrite?: {
    content: string;
    changes: string[];
  };
}

export interface AIOutputConcern {
  /** Type of concern */
  type: 'brand_misrepresentation' | 'tone_inconsistency' | 'factual_risk' | 'compliance_risk' | 'voice_drift';
  /** Severity level */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /** Description of the concern */
  description: string;
  /** Suggested fix */
  suggestion: string;
  /** Location in content (if applicable) */
  location?: {
    start: number;
    end: number;
    text: string;
  };
}

/**
 * Validates AI-generated content for brand compliance and consistency
 */
export class AIOutputValidator {
  private voiceManager: VoiceContextManager;

  constructor() {
    // Initialize with default configuration
    this.voiceManager = new VoiceContextManager({
      defaultPack: 'saas',
      contextPacks: [
        { context: 'email', packName: 'saas', description: 'Professional email communication' },
        { context: 'support', packName: 'saas', description: 'Customer support interactions' },
        { context: 'legal', packName: 'legal', description: 'Legal and compliance content' },
        { context: 'marketing', packName: 'saas', description: 'Marketing and promotional content' },
        { context: 'sales', packName: 'saas', description: 'Sales communications' }
      ]
    });
  }

  /**
   * Validate AI-generated content for brand compliance
   */
  async validate(request: AIOutputValidationRequest): Promise<AIOutputValidationResult> {
    const { content, pack, context, includeRewrite } = request;

    // Select appropriate voice/pack
    const voiceSelection = await this.voiceManager.selectVoice(content, {
      contentType: context?.contentType,
      channel: context?.channel,
      audience: context?.audience,
      preferredPack: pack
    });

    // Load the pack
    const packObj = await this.voiceManager.getPack(voiceSelection);

    // Run standard validation
    const validation = validate({ pack: packObj, text: content });

    // Analyze AI-specific concerns
    const aiConcerns = await this.analyzeAIConcerns(content, context, packObj);

    // Calculate compliance score
    const score = this.calculateComplianceScore(validation, aiConcerns);
    const compliant = score >= 70; // Configurable threshold

    // Generate recommendations
    const recommendations = this.generateRecommendations(validation, aiConcerns, voiceSelection.context);

    const result: AIOutputValidationResult = {
      score,
      compliant,
      validation,
      aiConcerns,
      recommendations,
      contextAnalysis: {
        detectedContext: voiceSelection.context,
        confidence: voiceSelection.confidence,
        selectedPack: voiceSelection.packName,
        reason: voiceSelection.reason
      }
    };

    // Add rewrite if requested
    if (includeRewrite && (!compliant || aiConcerns.some(c => c.severity === 'high' || c.severity === 'critical'))) {
      result.rewrite = await this.generateRewrite(content, packObj, aiConcerns);
    }

    return result;
  }

  /**
   * Analyze AI-specific concerns in the content
   */
  private async analyzeAIConcerns(
    content: string, 
    context: AIOutputValidationRequest['context'] | undefined,
    pack: any
  ): Promise<AIOutputConcern[]> {
    const concerns: AIOutputConcern[] = [];

    // Check for common AI hallucination patterns
    concerns.push(...this.checkFactualRisks(content, context));

    // Check for tone consistency with brand
    concerns.push(...this.checkToneConsistency(content, pack));

    // Check for compliance risks
    concerns.push(...this.checkComplianceRisks(content, context));

    // Check for voice drift (AI reverting to generic patterns)
    concerns.push(...this.checkVoiceDrift(content, pack));

    return concerns;
  }

  private checkFactualRisks(content: string, _context?: AIOutputValidationRequest['context']): AIOutputConcern[] {
    const concerns: AIOutputConcern[] = [];
    const _lowerContent = content.toLowerCase();

    // Check for potentially problematic AI patterns
    const riskPatterns = [
      { pattern: /as an ai|i'm an ai|i am an ai/gi, message: 'AI identity disclosure may confuse customers' },
      { pattern: /i cannot|i can't|i'm not able to/gi, message: 'Overly restrictive language may frustrate users' },
      { pattern: /according to my training|in my training data/gi, message: 'References to AI training may undermine trust' },
      { pattern: /i don't have real-time|i don't have access/gi, message: 'Limitations disclosure may seem unprofessional' }
    ];

    for (const { pattern, message } of riskPatterns) {
      const matches = content.match(pattern);
      if (matches) {
        concerns.push({
          type: 'factual_risk',
          severity: 'medium',
          description: message,
          suggestion: 'Rewrite to focus on what can be provided rather than limitations'
        });
      }
    }

    return concerns;
  }

  private checkToneConsistency(content: string, pack: any): AIOutputConcern[] {
    const concerns: AIOutputConcern[] = [];

    // Check if content matches pack's tone attributes
    const toneAttributes = pack.voice?.tone?.attributes || [];
    const _contentLower = content.toLowerCase();

    // Check for overly formal language when casual tone is expected
    if (toneAttributes.includes('casual') || toneAttributes.includes('conversational')) {
      const formalPatterns = [
        /furthermore|moreover|additionally|consequently/gi,
        /pursuant to|in accordance with|hereby/gi,
        /it is imperative|it is essential/gi
      ];

      for (const pattern of formalPatterns) {
        if (pattern.test(content)) {
          concerns.push({
            type: 'tone_inconsistency',
            severity: 'medium',
            description: 'Content uses overly formal language for casual brand voice',
            suggestion: 'Use more conversational language that matches brand personality'
          });
          break;
        }
      }
    }

    // Check for overly casual language when formal tone is expected
    if (toneAttributes.includes('professional') || toneAttributes.includes('formal')) {
      const casualPatterns = [
        /hey there|what's up|gonna|wanna/gi,
        /super cool|awesome|totally/gi,
        /lol|omg|btw/gi
      ];

      for (const pattern of casualPatterns) {
        if (pattern.test(content)) {
          concerns.push({
            type: 'tone_inconsistency',
            severity: 'high',
            description: 'Content uses overly casual language for professional brand voice',
            suggestion: 'Use more professional language that maintains brand authority'
          });
          break;
        }
      }
    }

    return concerns;
  }

  private checkComplianceRisks(content: string, context?: AIOutputValidationRequest['context']): AIOutputConcern[] {
    const concerns: AIOutputConcern[] = [];

    // Check for legal/compliance issues based on industry context
    if (context?.contentType === 'legal' || content.toLowerCase().includes('legal')) {
      const legalRisks = [
        { pattern: /guarantee|promise|ensure/gi, message: 'Absolute guarantees may create legal liability' },
        { pattern: /always|never|100%/gi, message: 'Absolute statements may not be legally defensible' }
      ];

      for (const { pattern, message } of legalRisks) {
        if (pattern.test(content)) {
          concerns.push({
            type: 'compliance_risk',
            severity: 'high',
            description: message,
            suggestion: 'Use qualified language like "typically" or "under normal circumstances"'
          });
        }
      }
    }

    // Check for financial advice disclaimers
    if (content.toLowerCase().includes('invest') || content.toLowerCase().includes('financial')) {
      if (!content.toLowerCase().includes('not financial advice') && !content.toLowerCase().includes('consult')) {
        concerns.push({
          type: 'compliance_risk',
          severity: 'critical',
          description: 'Financial content may require disclaimers',
          suggestion: 'Add appropriate disclaimers and advice to consult professionals'
        });
      }
    }

    return concerns;
  }

  private checkVoiceDrift(content: string, _pack: any): AIOutputConcern[] {
    const concerns: AIOutputConcern[] = [];

    // Check for generic AI assistant patterns that don't match brand voice
    const genericPatterns = [
      { pattern: /I'd be happy to help|I'm here to assist/gi, message: 'Generic assistant language doesn\'t match brand voice' },
      { pattern: /let me know if you have any questions/gi, message: 'Standard closing may not align with brand personality' },
      { pattern: /I hope this helps|I hope this information is helpful/gi, message: 'Generic helpfulness language lacks brand character' }
    ];

    for (const { pattern, message } of genericPatterns) {
      if (pattern.test(content)) {
        concerns.push({
          type: 'voice_drift',
          severity: 'medium',
          description: message,
          suggestion: 'Replace with brand-specific language that reflects company personality'
        });
      }
    }

    return concerns;
  }

  private calculateComplianceScore(validation: any, aiConcerns: AIOutputConcern[]): number {
    let baseScore = validation.score || 70;

    // Deduct points for AI-specific concerns
    for (const concern of aiConcerns) {
      switch (concern.severity) {
        case 'critical':
          baseScore -= 20;
          break;
        case 'high':
          baseScore -= 10;
          break;
        case 'medium':
          baseScore -= 5;
          break;
        case 'low':
          baseScore -= 2;
          break;
      }
    }

    return Math.max(0, Math.min(100, Math.round(baseScore)));
  }

  private generateRecommendations(
    validation: any, 
    aiConcerns: AIOutputConcern[],
    context: string
  ): string[] {
    const recommendations: string[] = [];

    // Add standard validation recommendations
    if (validation.violations && validation.violations.length > 0) {
      recommendations.push('Address brand voice violations to improve consistency');
    }

    // Add AI-specific recommendations
    const criticalConcerns = aiConcerns.filter(c => c.severity === 'critical');
    const highConcerns = aiConcerns.filter(c => c.severity === 'high');

    if (criticalConcerns.length > 0) {
      recommendations.push('Immediately address critical compliance issues before publication');
    }

    if (highConcerns.length > 0) {
      recommendations.push('Review and fix high-severity tone or voice issues');
    }

    // Add context-specific recommendations
    const contextTips = this.voiceManager.getContextualTips(context as any);
    if (contextTips.length > 0) {
      recommendations.push(`For ${context} content: ${contextTips[0]}`);
    }

    return recommendations;
  }

  private async generateRewrite(
    content: string,
    _pack: any,
    _concerns: AIOutputConcern[]
  ): Promise<{ content: string; changes: string[] }> {
    // This is a simplified rewrite - in production, this would call the AI rewriter
    // For now, return the original content with basic fixes
    let rewrittenContent = content;
    const changes: string[] = [];

    // Apply basic automated fixes for common AI patterns
    const fixes = [
      { pattern: /as an ai|i'm an ai|i am an ai/gi, replacement: 'we', change: 'Removed AI self-identification' },
      { pattern: /I'd be happy to help/gi, replacement: 'Let me help you with that', change: 'Used more direct language' },
      { pattern: /I hope this helps/gi, replacement: 'This should get you started', change: 'Used more confident language' }
    ];

    for (const { pattern, replacement, change } of fixes) {
      if (pattern.test(rewrittenContent)) {
        rewrittenContent = rewrittenContent.replace(pattern, replacement);
        changes.push(change);
      }
    }

    return {
      content: rewrittenContent,
      changes
    };
  }
}