// test-sms.js
const crypto = require('crypto');
const fetch = globalThis.fetch ?? require('node-fetch');

// 1. Setup Secrets (matching your env)
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key';
const SMS_API_KEY = process.env.SMS_API_KEY || 'GoodGuy@123';

// 2. Generate JWT (HS256)
const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
const payload = Buffer.from(JSON.stringify({ sub: '2', iat: Math.floor(Date.now()/1000) })).toString('base64url');
const signature = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + payload).digest('base64url');
const token = header + '.' + payload + '.' + signature;

(async () => {
  try {
    console.log('Generated Token:', token);
    console.log('Sending request...');
    
    const res = await fetch('http://localhost:3000/api/sms/ingest', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'x-sms-api-key': SMS_API_KEY
      },
      body: JSON.stringify({
        sender: '+919619183585',
        message: 'Sent Rs.500 to Starbucks via UPI ref: TEST123'
      })
    });

    console.log('Status:', res.status);
    const data = await res.json();
    
    console.log('\n--- RESPONSE BODY ---');
    console.log(JSON.stringify(data, null, 2));
    
    // Check specifically for the Mill Prompt we just fixed
    if (data.agentResponse) {
      console.log('\n--- MILL AGENT RESPONSE ---');
      // The response structure depends on your agent implementation, 
      // usually it's in data.agentResponse directly or inside a wrapper
      console.log(data.agentResponse);
    }
  } catch (e) {
    console.error('Error:', e);
  }
})();