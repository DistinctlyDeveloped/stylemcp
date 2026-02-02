#!/usr/bin/env node

/**
 * Quick test of new StyleMCP enhancements
 */

import { VoiceAnalyzer } from './dist/learn/voice-analyzer.js';
import { VoiceContextManager } from './dist/utils/voice-context.js';

async function testVoiceAnalyzer() {
  console.log('🧪 Testing Voice Analyzer...');
  
  const analyzer = new VoiceAnalyzer();
  const samples = [
    {
      text: "Hey there! We're excited to help you get started with our awesome platform. It's super easy to use and will save you tons of time.",
      context: 'marketing'
    },
    {
      text: "Thanks for reaching out! I understand the issue you're facing. Let me walk you through the solution step by step.",
      context: 'support'
    },
    {
      text: "Our new feature leverages cutting-edge technology to facilitate synergy between your workflows.",
      context: 'marketing'
    }
  ];

  try {
    const result = await analyzer.analyze(samples);
    
    console.log('✅ Voice Analysis Result:');
    console.log(`- Confidence: ${result.confidence}%`);
    console.log(`- Tone: ${result.profile.tone.summary}`);
    console.log(`- Detected patterns: ${result.profile.patterns.length}`);
    console.log(`- Vocabulary rules: ${result.profile.vocabulary.rules.length}`);
    console.log(`- Recommendations: ${result.recommendations.length}`);
    
    if (result.profile.patterns.length > 0) {
      console.log('\nDetected anti-patterns:');
      result.profile.patterns.forEach(p => {
        console.log(`  - ${p.pattern}: ${p.reason}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Voice Analyzer test failed:', error.message);
  }
}

async function testVoiceContext() {
  console.log('\n🧪 Testing Voice Context Manager...');
  
  const manager = new VoiceContextManager();
  
  const testTexts = [
    {
      text: "Thanks for contacting support. I'll help you resolve this issue.",
      expectedContext: 'support'
    },
    {
      text: "Check out our new pricing plans. Get 50% off your first month!",
      expectedContext: 'marketing'
    },
    {
      text: "Our terms of service have been updated to comply with GDPR regulations.",
      expectedContext: 'legal'
    },
    {
      text: "Team meeting at 2 PM to discuss the project roadmap and Q1 goals.",
      expectedContext: 'internal'
    }
  ];

  console.log('✅ Context Detection Results:');
  
  for (const { text, expectedContext } of testTexts) {
    try {
      const selection = await manager.selectVoice(text);
      const match = selection.context === expectedContext ? '✅' : '⚠️';
      
      console.log(`${match} "${text.slice(0, 50)}..."`);
      console.log(`   Expected: ${expectedContext} | Detected: ${selection.context} (${selection.confidence.toFixed(1)})`);
      
    } catch (error) {
      console.error(`❌ Failed to detect context for: ${text.slice(0, 30)}...`);
    }
  }
  
  // Test context mappings
  console.log('\n✅ Available Context Mappings:');
  const mappings = manager.listContextMappings();
  mappings.forEach(mapping => {
    const defaultFlag = mapping.isDefault ? ' (default)' : '';
    console.log(`  - ${mapping.context} → ${mapping.packName}${defaultFlag}`);
  });
}

async function runTests() {
  console.log('🚀 StyleMCP Enhancement Tests\n');
  
  await testVoiceAnalyzer();
  await testVoiceContext();
  
  console.log('\n✅ All tests completed!');
}

runTests().catch(error => {
  console.error('❌ Test suite failed:', error);
  process.exit(1);
});