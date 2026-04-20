/**
 * Agent Proxy Route for dTweet
 * 
 * This route handles agent-authenticated tweet publishing.
 * It uses the working hprose client to call add_tweet on the backend.
 */

const express = require('express');
const crypto = require('crypto');

const APP_ID = 'd4lRyhABgqOnqY4bURSm_T-4FZ4';
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

// Sort object keys recursively for consistent signing
function sortKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sortKeys);
  return Object.keys(obj).sort().reduce((o, k) => { o[k] = sortKeys(obj[k]); return o; }, {});
}

// Sign request using Ed25519
function signRequest(data, token) {
  const timestamp = Date.now();
  const signable = sortKeys({ ...data, mimeiId: token.mimeiId, timestamp });
  const message = Buffer.from(JSON.stringify(signable), 'utf8');
  const privateKeyRaw = Buffer.from(token.privateKey, 'base64');
  const privateKeyDer = privateKeyRaw.length === 32 
    ? Buffer.concat([PKCS8_PREFIX, privateKeyRaw]) 
    : privateKeyRaw;
  const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: 'der', type: 'pkcs8' });
  const signature = crypto.sign(null, message, privateKey).toString('base64');
  return { mimeiId: token.mimeiId, timestamp, signature };
}

module.exports = function() {
  const router = express.Router();
  
  // Parse JSON body
  router.use(express.json({ limit: '10mb' }));
  
  /**
   * POST /api/agent/post-tweet
   * Publish a tweet using agent authentication
   */
  router.post('/post-tweet', async (req, res) => {
    let client = null;
    
    try {
      const { token: tokenB64, content, attachments = [] } = req.body;
      
      // Validate
      if (!tokenB64 || !content) {
        return res.status(400).json({
          success: false,
          error: 'Missing required fields: token, content'
        });
      }
      
      // Decode token
      let token;
      try {
        token = JSON.parse(Buffer.from(tokenB64, 'base64').toString('utf8'));
      } catch (e) {
        return res.status(400).json({
          success: false,
          error: 'Invalid token format'
        });
      }
      
      // Check Leither availability
      if (!global.isLeitherInitialized || !global.isLeitherInitialized()) {
        return res.status(503).json({
          success: false,
          error: 'Leither service not initialized'
        });
      }
      
      // Get Leither connection
      client = await global.getLeitherConnection();
      
      // Get user info to find host
      const userResult = await client.RunMApp('get_user', {
        aid: APP_ID,
        ver: 'last',
        userid: token.mimeiId
      });
      
      const userData = userResult?.data || userResult;
      if (typeof userData === 'string' || !userData?.hostIds?.[0]) {
        global.releaseLeitherConnection(client);
        return res.status(404).json({
          success: false,
          error: 'User not found'
        });
      }
      
      const hostId = userData.hostIds[0];
      
      // Resolve host IP
      const nodeResult = await client.RunMApp('get_node_ips', {
        aid: APP_ID,
        ver: 'last',
        version: 'v2',
        nodeid: hostId,
        v4only: 'true'
      });
      
      const ips = Array.isArray(nodeResult) ? nodeResult : 
                  (nodeResult?.data && Array.isArray(nodeResult.data)) ? nodeResult.data :
                  [nodeResult];
      const hostIp = ips[0]?.trim();
      
      if (!hostIp) {
        global.releaseLeitherConnection(client);
        return res.status(500).json({
          success: false,
          error: 'Could not resolve host IP'
        });
      }
      
      // Release the connection before creating host client
      global.releaseLeitherConnection(client);
      client = null;
      
      // Create host client using hprose
      const hprose = require('hprose');
      const hostClient = hprose.Client.create(`ws://${hostIp}/ws/`, ['RunMApp']);
      hostClient.timeout = 60000;
      
      // Prepare tweet
      const tweet = {
        authorId: token.mimeiId,
        content,
        isPrivate: false,
        downloadable: true,
        attachments: attachments.map(a => ({
          mid: a.mid,
          type: a.type || 'video',
          size: a.size || 0,
          fileName: a.fileName || 'media.mp4',
          timestamp: a.timestamp || Date.now()
        }))
      };
      
      // Sign the request
      const requestData = { authorId: tweet.authorId, content: tweet.content };
      const agentAuth = signRequest(requestData, token);
      
      // Publish
      const result = await hostClient.RunMApp('add_tweet', {
        aid: APP_ID,
        ver: 'last',
        tweet: JSON.stringify(tweet),
        agentAuth
      });
      
      res.json(result);
      
    } catch (error) {
      console.error('[AGENT-PROXY] Error:', error);
      res.status(500).json({
        success: false,
        error: error.message || 'Internal server error'
      });
    } finally {
      if (client) {
        global.releaseLeitherConnection(client);
      }
    }
  });
  
  /**
   * GET /api/agent/health
   */
  router.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      timestamp: Date.now(),
      leitherReady: global.isLeitherInitialized ? global.isLeitherInitialized() : false
    });
  });
  
  return router;
};
