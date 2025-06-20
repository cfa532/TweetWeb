/**
 * Simple server connectivity test
 */

const fetch = require('node-fetch');

async function testServer() {
  try {
    console.log('Testing server connectivity...');
    
    // Test basic connectivity
    const response = await fetch('http://localhost:3000/');
    console.log('Server response status:', response.status);
    console.log('Server response headers:', response.headers.get('content-type'));
    
    // Test the extract-tar endpoint with a simple request
    const testResponse = await fetch('http://localhost:3000/extract-tar', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    
    console.log('Extract-tar endpoint status:', testResponse.status);
    console.log('Extract-tar endpoint content-type:', testResponse.headers.get('content-type'));
    
    const text = await testResponse.text();
    console.log('Response body (first 200 chars):', text.substring(0, 200));
    
  } catch (error) {
    console.error('Server test failed:', error.message);
    console.log('\nPossible issues:');
    console.log('1. Server is not running - start it with: npm start');
    console.log('2. Server is running on a different port');
    console.log('3. Dependencies are not installed - run: npm install');
  }
}

if (require.main === module) {
  testServer();
}

module.exports = { testServer }; 