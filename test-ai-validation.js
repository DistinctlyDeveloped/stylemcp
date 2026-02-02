#!/usr/bin/env node

/**
 * Test script for AI Output Validation feature
 * Tests the new endpoint with sample AI-generated content
 */

const baseUrl = 'http://localhost:3000';

const testCases = [
  {
    name: 'Generic AI Assistant Response',
    content: `Hi there! I'm an AI assistant and I'd be happy to help you with your question. Based on my training data, I can provide you with some information, but I don't have access to real-time data. I hope this helps! Let me know if you have any other questions.`,
    context: {
      aiSystem: 'chatgpt',
      contentType: 'support',
      audience: 'customer'
    }
  },
  {
    name: 'Professional Email Draft',
    content: `Dear valued customer,\n\nThank you for reaching out to us regarding your recent inquiry. We have carefully reviewed your request and are pleased to inform you that we can assist you with this matter.\n\nWe will ensure that your concerns are addressed promptly and professionally. Please feel free to contact us if you require any additional assistance.\n\nBest regards,\nThe Support Team`,
    context: {
      aiSystem: 'claude',
      contentType: 'email',
      audience: 'customer',
      channel: 'email'
    }
  },
  {
    name: 'Blog Post Draft',
    content: `In today's fast-paced digital landscape, businesses are constantly seeking innovative solutions to streamline their operations. Furthermore, the implementation of advanced technologies has revolutionized the way organizations approach their daily tasks. It is imperative that companies embrace these changes to remain competitive in the market.`,
    context: {
      aiSystem: 'gpt4',
      contentType: 'blog',
      audience: 'business'
    }
  },
  {
    name: 'Legal Content with Issues',
    content: `We guarantee that our service will always be 100% accurate and will never fail to meet your expectations. Our company promises complete satisfaction and ensures that you will never experience any problems with our product.`,
    context: {
      aiSystem: 'claude',
      contentType: 'legal',
      audience: 'customer'
    }
  }
];

async function testAIValidation() {
  console.log('🤖 Testing AI Output Validation Feature\n');

  for (const testCase of testCases) {
    console.log(`📝 Testing: ${testCase.name}`);
    console.log(`Content: "${testCase.content.substring(0, 80)}..."`);

    try {
      const response = await fetch(`${baseUrl}/api/ai-output/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': process.env.STYLEMCP_API_KEY || 'test-key'
        },
        body: JSON.stringify({
          content: testCase.content,
          pack: 'saas',
          context: testCase.context,
          includeRewrite: true
        })
      });

      if (!response.ok) {
        console.log(`❌ Error: ${response.status} ${response.statusText}\n`);
        continue;
      }

      const result = await response.json();
      
      console.log(`📊 Score: ${result.score}/100 (${result.compliant ? '✅ Compliant' : '⚠️  Non-compliant'})`);
      console.log(`🎯 Context: ${result.contextAnalysis.detectedContext} (${result.contextAnalysis.confidence * 100}% confidence)`);
      console.log(`📦 Pack: ${result.contextAnalysis.selectedPack}`);
      
      if (result.aiConcerns.length > 0) {
        console.log(`⚠️  AI Concerns:`);
        result.aiConcerns.forEach(concern => {
          console.log(`   • ${concern.severity.toUpperCase()}: ${concern.description}`);
        });
      }

      if (result.recommendations.length > 0) {
        console.log(`💡 Recommendations:`);
        result.recommendations.slice(0, 2).forEach(rec => {
          console.log(`   • ${rec}`);
        });
      }

      if (result.rewrite) {
        console.log(`✏️  Changes: ${result.rewrite.changes.join(', ')}`);
      }

      console.log(''); // Empty line for readability

    } catch (error) {
      console.log(`❌ Error: ${error.message}\n`);
    }
  }
}

// Test analytics endpoint
async function testAnalytics() {
  console.log('📈 Testing Analytics Endpoint\n');

  try {
    const response = await fetch(`${baseUrl}/api/analytics/usage`, {
      headers: {
        'X-Api-Key': process.env.STYLEMCP_API_KEY || 'test-key'
      }
    });

    if (response.ok) {
      const stats = await response.json();
      console.log(`📊 Total Validations: ${stats.totalValidations}`);
      console.log(`📈 Average Score: ${stats.averageScore}/100`);
      console.log(`🏆 Top Pack: ${stats.topPacks[0].name} (${stats.topPacks[0].usage}% usage)`);
      console.log(`🚨 Top Issue: ${stats.topViolations[0].type} (${stats.topViolations[0].count} instances)`);
    } else {
      console.log(`❌ Analytics Error: ${response.status} ${response.statusText}`);
    }
  } catch (error) {
    console.log(`❌ Analytics Error: ${error.message}`);
  }

  console.log('');
}

// Run tests
async function runTests() {
  // Check if server is running
  try {
    const healthCheck = await fetch(`${baseUrl}/health`);
    if (!healthCheck.ok) {
      console.log('❌ Server not responding. Make sure StyleMCP server is running on port 3000');
      process.exit(1);
    }
  } catch (error) {
    console.log('❌ Server not reachable. Make sure StyleMCP server is running on port 3000');
    process.exit(1);
  }

  await testAIValidation();
  await testAnalytics();
  
  console.log('✅ All tests completed!');
  console.log('\n💡 Next steps:');
  console.log('• Review the AI concerns and recommendations');
  console.log('• Test with your own AI-generated content');
  console.log('• Integrate into your content workflow');
}

runTests().catch(console.error);