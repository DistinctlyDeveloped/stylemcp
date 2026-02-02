import { Pack } from '../schema/index.js';
import { loadPack, getPacksDirectory, listAvailablePacks } from './pack-loader.js';
import { join } from 'path';

export type VoiceContext = 
  | 'email' 
  | 'blog' 
  | 'social' 
  | 'marketing' 
  | 'support' 
  | 'legal' 
  | 'internal' 
  | 'product'
  | 'sales';

export interface ContextualVoice {
  context: VoiceContext;
  packName: string;
  description?: string;
}

export interface MultiVoiceConfig {
  defaultPack: string;
  contextPacks: ContextualVoice[];
  fallbackPack?: string;
}

export interface VoiceSelection {
  packName: string;
  context: VoiceContext;
  confidence: number; // How confident we are this is the right context
  reason: string;
}

/**
 * Manages multiple voices for different contexts
 */
export class VoiceContextManager {
  private config: MultiVoiceConfig;
  private packCache = new Map<string, Pack>();

  constructor(config?: MultiVoiceConfig) {
    this.config = config || {
      defaultPack: 'saas',
      contextPacks: []
    };
  }

  /**
   * Detect the appropriate voice context from content
   */
  detectContext(text: string, metadata?: { 
    channel?: string; 
    subject?: string; 
    audience?: string;
    contentType?: string;
  }): VoiceContext {
    const lowerText = text.toLowerCase();
    const subject = metadata?.subject?.toLowerCase() || '';
    const channel = metadata?.channel?.toLowerCase() || '';
    const contentType = metadata?.contentType?.toLowerCase() || '';

    // Channel-based detection
    if (channel.includes('email') || contentType.includes('email')) {
      return 'email';
    }
    if (channel.includes('social') || channel.includes('twitter') || channel.includes('linkedin')) {
      return 'social';
    }
    if (channel.includes('blog') || contentType.includes('blog') || contentType.includes('article')) {
      return 'blog';
    }

    // Content-based detection
    if (this.hasLegalIndicators(lowerText, subject)) {
      return 'legal';
    }
    if (this.hasSupportIndicators(lowerText, subject)) {
      return 'support';
    }
    if (this.hasSalesIndicators(lowerText, subject)) {
      return 'sales';
    }
    if (this.hasMarketingIndicators(lowerText, subject)) {
      return 'marketing';
    }
    if (this.hasProductIndicators(lowerText, subject)) {
      return 'product';
    }
    if (this.hasInternalIndicators(lowerText, subject)) {
      return 'internal';
    }

    // Default to email for unknown content
    return 'email';
  }

  private hasLegalIndicators(text: string, subject: string): boolean {
    const legalTerms = [
      'terms of service', 'privacy policy', 'legal', 'disclaimer',
      'liability', 'warranty', 'agreement', 'contract', 'compliance',
      'gdpr', 'ccpa', 'terms and conditions', 'intellectual property'
    ];
    return legalTerms.some(term => text.includes(term) || subject.includes(term));
  }

  private hasSupportIndicators(text: string, subject: string): boolean {
    const supportTerms = [
      'help', 'support', 'issue', 'problem', 'bug', 'error',
      'troubleshoot', 'assistance', 'contact us', 'customer service',
      'ticket', 'resolve', 'solution', 'how to', 'faq'
    ];
    return supportTerms.some(term => text.includes(term) || subject.includes(term));
  }

  private hasSalesIndicators(text: string, subject: string): boolean {
    const salesTerms = [
      'pricing', 'buy', 'purchase', 'sale', 'discount', 'offer',
      'free trial', 'demo', 'quote', 'proposal', 'upgrade',
      'plan', 'package', 'subscription', 'billing'
    ];
    return salesTerms.some(term => text.includes(term) || subject.includes(term));
  }

  private hasMarketingIndicators(text: string, subject: string): boolean {
    const marketingTerms = [
      'newsletter', 'announcement', 'launch', 'new feature',
      'campaign', 'promotion', 'webinar', 'event', 'update',
      'introducing', 'excited to share', 'now available'
    ];
    return marketingTerms.some(term => text.includes(term) || subject.includes(term));
  }

  private hasProductIndicators(text: string, subject: string): boolean {
    const productTerms = [
      'feature', 'functionality', 'release', 'version', 'update',
      'changelog', 'roadmap', 'development', 'improvement',
      'enhancement', 'specification', 'documentation'
    ];
    return productTerms.some(term => text.includes(term) || subject.includes(term));
  }

  private hasInternalIndicators(text: string, subject: string): boolean {
    const internalTerms = [
      'team', 'internal', 'employee', 'staff', 'meeting',
      'memo', 'hr', 'onboarding', 'policy', 'process',
      'workflow', 'project', 'deadline', 'status update'
    ];
    return internalTerms.some(term => text.includes(term) || subject.includes(term));
  }

  /**
   * Select the best voice pack for the detected context
   */
  async selectVoice(text: string, metadata?: { 
    channel?: string; 
    subject?: string; 
    audience?: string;
    contentType?: string;
    preferredPack?: string;
  }): Promise<VoiceSelection> {
    // If a specific pack is requested, use it
    if (metadata?.preferredPack) {
      const availablePacks = await listAvailablePacks();
      if (availablePacks.includes(metadata.preferredPack)) {
        return {
          packName: metadata.preferredPack,
          context: this.detectContext(text, metadata),
          confidence: 1.0,
          reason: 'Explicitly requested'
        };
      }
    }

    const context = this.detectContext(text, metadata);
    
    // Look for a context-specific pack
    const contextPack = this.config.contextPacks.find(cp => cp.context === context);
    if (contextPack) {
      const availablePacks = await listAvailablePacks();
      if (availablePacks.includes(contextPack.packName)) {
        return {
          packName: contextPack.packName,
          context,
          confidence: 0.8,
          reason: `Matched context: ${context}`
        };
      }
    }

    // Fall back to default pack
    const defaultPack = this.config.fallbackPack || this.config.defaultPack;
    return {
      packName: defaultPack,
      context,
      confidence: 0.6,
      reason: `Using default pack for context: ${context}`
    };
  }

  /**
   * Get the pack for a specific voice selection
   */
  async getPack(selection: VoiceSelection): Promise<Pack> {
    if (this.packCache.has(selection.packName)) {
      return this.packCache.get(selection.packName)!;
    }

    const packPath = join(getPacksDirectory(), selection.packName);
    const result = await loadPack({ packPath });
    
    this.packCache.set(selection.packName, result.pack);
    return result.pack;
  }

  /**
   * Update the multi-voice configuration
   */
  updateConfig(config: Partial<MultiVoiceConfig>): void {
    this.config = { ...this.config, ...config };
    // Clear cache when config changes
    this.packCache.clear();
  }

  /**
   * Add a context-specific voice
   */
  addContextVoice(contextVoice: ContextualVoice): void {
    // Remove existing entry for this context
    this.config.contextPacks = this.config.contextPacks.filter(
      cp => cp.context !== contextVoice.context
    );
    // Add new entry
    this.config.contextPacks.push(contextVoice);
  }

  /**
   * Remove a context-specific voice
   */
  removeContextVoice(context: VoiceContext): void {
    this.config.contextPacks = this.config.contextPacks.filter(
      cp => cp.context !== context
    );
  }

  /**
   * Get current configuration
   */
  getConfig(): MultiVoiceConfig {
    return { ...this.config };
  }

  /**
   * List available contexts and their assigned packs
   */
  listContextMappings(): Array<{
    context: VoiceContext;
    packName: string;
    isDefault: boolean;
    description?: string;
  }> {
    const mappings = this.config.contextPacks.map(cp => ({
      context: cp.context,
      packName: cp.packName,
      isDefault: false,
      description: cp.description
    }));

    // Add contexts that fall back to default
    const allContexts: VoiceContext[] = [
      'email', 'blog', 'social', 'marketing', 'support', 
      'legal', 'internal', 'product', 'sales'
    ];
    
    const assignedContexts = new Set(mappings.map(m => m.context));
    
    for (const context of allContexts) {
      if (!assignedContexts.has(context)) {
        mappings.push({
          context,
          packName: this.config.defaultPack,
          isDefault: true,
          description: `Falls back to default pack`
        });
      }
    }

    return mappings;
  }

  /**
   * Get context-aware validation suggestions
   */
  getContextualTips(context: VoiceContext): string[] {
    const tips: Record<VoiceContext, string[]> = {
      email: [
        'Use clear, actionable subject lines',
        'Keep paragraphs short for mobile reading',
        'Include clear CTAs',
        'Use personal pronouns appropriately'
      ],
      blog: [
        'Write scannable headlines',
        'Use subheadings to break up content',
        'Include takeaways and actionable insights',
        'Optimize for SEO while maintaining voice'
      ],
      social: [
        'Keep it concise and engaging',
        'Use platform-appropriate tone',
        'Include relevant hashtags',
        'Encourage interaction'
      ],
      marketing: [
        'Focus on benefits over features',
        'Create urgency without pressure',
        'Use social proof',
        'Include clear value propositions'
      ],
      support: [
        'Be empathetic and solution-focused',
        'Use clear, step-by-step instructions',
        'Acknowledge customer concerns',
        'Provide escalation paths'
      ],
      legal: [
        'Use plain language when possible',
        'Be precise and unambiguous',
        'Include necessary disclaimers',
        'Follow compliance requirements'
      ],
      internal: [
        'Be direct and efficient',
        'Use company-specific terminology',
        'Focus on actions and outcomes',
        'Consider company culture'
      ],
      product: [
        'Focus on user value',
        'Use consistent terminology',
        'Be clear about functionality',
        'Consider technical audience'
      ],
      sales: [
        'Focus on customer needs',
        'Use consultative approach',
        'Be specific about value',
        'Create trust and credibility'
      ]
    };

    return tips[context] || [];
  }
}