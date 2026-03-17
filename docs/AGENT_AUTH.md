# Agent Authentication API

AI agent authentication system for programmatically publishing tweets without requiring user passwords. This API uses Ed25519 digital signatures for secure, token-based authentication.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Token Structure](#token-structure)
- [Authentication Flow](#authentication-flow)
- [API Reference](#api-reference)
- [JavaScript/TypeScript SDK](#javascripttypescript-sdk)
- [Backend Integration](#backend-integration)
- [Security Considerations](#security-considerations)
- [Examples](#examples)

## Overview

The Agent Authentication API allows AI agents and third-party applications to publish tweets on behalf of users using cryptographically signed requests. Instead of storing and transmitting passwords, agents use Ed25519 keypairs to prove authorization.

### Key Features

- 🔐 **Passwordless Authentication** - No password storage required
- 🔏 **Cryptographic Signatures** - Ed25519 signatures ensure request integrity
- ⏱️ **Request Freshness** - 5-minute request expiration prevents replay attacks
- 🔄 **Token Portability** - Export/import tokens as base64 strings
- 🎯 **Scoped Access** - Define allowed actions (post, comment, like)

## Quick Start

### 1. Generate an Agent Token

```typescript
import { generateAgentToken, exportToken } from '@/utils/agentAuth';

// Generate a new token for a user
const token = await generateAgentToken('user_mimei_id', ['post', 'comment']);

// Export as portable string
const tokenString = exportToken(token);
console.log('Token:', tokenString);
```

### 2. Sign and Publish a Tweet

```typescript
import { useAgentTweet } from '@/composables/useAgentTweet';

const { publishTweet } = useAgentTweet();

const tweet = {
    authorId: 'user_mimei_id',
    content: 'Hello from my AI agent! 🤖',
    title: '',
    isPrivate: false,
    downloadable: false
};

const result = await publishTweet(tweet, token);
console.log('Published:', result.mid);
```

### 3. Demo Page

Access the interactive demo at `/agent-auth-demo` to test the API:

```
http://localhost:5173/agent-auth-demo
```

## Token Structure

### AgentToken

```typescript
interface AgentToken {
    version: number;        // Token format version (currently 1)
    mimeiId: string;        // User's Mimei ID
    privateKey: string;     // Base64-encoded Ed25519 private key
    publicKey: string;      // Base64-encoded Ed25519 public key
    createdAt: number;      // Unix timestamp (milliseconds)
    scope: string[];        // Allowed actions: ["post", "comment", "like"]
}
```

### AgentAuth (Request Payload)

```typescript
interface AgentAuth {
    mimeiId: string;        // User's Mimei ID
    timestamp: number;      // Request timestamp (milliseconds)
    signature: string;      // Base64-encoded Ed25519 signature
}
```

### Exported Token Format

Tokens are exported as base64-encoded JSON:

```
eyJ2ZXJzaW9uIjoxLCJtaW1laUlkIjoiLi4uIiwicHJpdmF0ZUtleSI6Ii4uLiIsInB1YmxpY0tleSI6Ii4uLiIsImNyZWF0ZWRBdCI6MTIzNDU2LCJzY29wZSI6WyJwb3N0IiwiY29tbWVudCJdfQ==
```

## Authentication Flow

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  AI Agent   │────▶│ Sign Request │────▶│   Backend   │
│  (Client)   │     │  (Ed25519)   │     │  (Server)   │
└─────────────┘     └──────────────┘     └─────────────┘
                                                  │
                                                  ▼
                                           ┌──────────────┐
                                           │ Verify Token │
                                           │  Signature   │
                                           └──────────────┘
                                                  │
                                                  ▼
                                           ┌──────────────┐
                                           │  Publish     │
                                           │   Tweet      │
                                           └──────────────┘
```

### Signing Process

1. **Create Signable Data**:
   ```javascript
   {
       authorId: "user_mimei_id",
       content: "tweet content",
       mimeiId: "user_mimei_id",
       timestamp: 1234567890123
   }
   ```

2. **Sort Keys** (for consistent serialization):
   ```javascript
   // Keys sorted alphabetically
   {
       authorId: "user_mimei_id",
       content: "tweet content",
       mimeiId: "user_mimei_id",
       timestamp: 1234567890123
   }
   ```

3. **JSON Stringify** and **Sign** with Ed25519 private key

4. **Send Request** with `AgentAuth` object

### Verification Process

1. **Extract** `mimeiId`, `timestamp`, `signature` from `AgentAuth`
2. **Validate timestamp** (must be within 5 minutes, allow 1 min clock skew)
3. **Fetch user's public key** from their profile data
4. **Reconstruct signed data** with sorted keys
5. **Verify signature** using Ed25519
6. **Execute request** if valid

## API Reference

### Utility Functions

#### `generateAgentToken(mimeiId, scope?)`

Generate a new Ed25519 keypair and create an agent token.

**Parameters:**
- `mimeiId` (string): User's Mimei ID
- `scope` (string[], optional): Allowed actions, default: `["post", "comment"]`

**Returns:** `Promise<AgentToken>`

**Example:**
```typescript
const token = await generateAgentToken('user123', ['post', 'comment', 'like']);
```

---

#### `signRequest(data, token)`

Sign request data using an agent token's private key.

**Parameters:**
- `data` (Record<string, any>): Data to sign (must include `authorId` and `content`)
- `token` (AgentToken): The agent token

**Returns:** `Promise<AgentAuth>`

**Example:**
```typescript
const auth = await signRequest(
    { authorId: 'user123', content: 'Hello!' },
    token
);
```

---

#### `exportToken(token)`

Export a token to a portable base64 string.

**Parameters:**
- `token` (AgentToken): The token to export

**Returns:** `string`

---

#### `importToken(tokenString)`

Import a token from a base64 string.

**Parameters:**
- `tokenString` (string): Base64-encoded token

**Returns:** `AgentToken | null`

---

#### `verifySignature(data, auth, publicKeyBase64)`

Verify a signature locally (for testing).

**Parameters:**
- `data` (Record<string, any>): Original signed data
- `auth` (AgentAuth): The authentication object with signature
- `publicKeyBase64` (string): The public key to verify against

**Returns:** `Promise<boolean>`

---

#### `publishTweetWithAgent(tweet, agentAuth, providerIp?)`

Publish a tweet using agent authentication.

**Parameters:**
- `tweet` (any): The tweet object
- `agentAuth` (AgentAuth): The signed authentication object
- `providerIp` (string, optional): Target provider IP

**Returns:** `Promise<{ success: boolean; mid?: string; message?: string }>`

---

#### `verifyAgentTokenWithBackend(agentAuth, requestData)`

Verify an agent token by calling the backend verification endpoint.

**Parameters:**
- `agentAuth` (AgentAuth): The authentication object
- `requestData` (Record<string, any>): Original request data

**Returns:** `Promise<{ valid: boolean; error?: string; mimeiId?: string }>`

---

### Composable: `useAgentTweet()`

Vue composable for reactive agent-authenticated tweet publishing.

```typescript
const {
    isPublishing,      // Ref<boolean> - publishing state
    publishResult,     // Ref<PublishResult | null> - last result
    lastAgentAuth,     // Ref<AgentAuth | null> - last auth used
    canPublish,        // Computed<boolean> - can publish now
    publishTweet,      // (tweet, token) => Promise<PublishResult>
    signTweetRequest,  // (tweet, token) => Promise<AgentAuth>
    verifyToken,       // (auth, data) => Promise<VerificationResult>
    generateAndExportToken, // (mimeiId, scope?) => Promise<{token, tokenString}>
    importTokenString, // (tokenString) => AgentToken | null
    clearResult        // () => void
} = useAgentTweet();
```

## JavaScript/TypeScript SDK

### Full Example

```vue
<script setup lang="ts">
import { ref } from 'vue';
import { 
    generateAgentToken, 
    exportToken, 
    importToken,
    publishTweetWithAgent,
    signRequest 
} from '@/utils/agentAuth';

const tokenString = ref('');
const result = ref('');

async function createAndPublish() {
    // 1. Generate token (normally done once, stored securely)
    const token = await generateAgentToken('user123', ['post']);
    tokenString.value = exportToken(token);
    
    // 2. Create tweet
    const tweet = {
        authorId: 'user123',
        content: 'Posted via AI agent API!',
        title: '',
        isPrivate: false,
        downloadable: false,
        attachments: []
    };
    
    // 3. Sign the request
    const auth = await signRequest({
        authorId: tweet.authorId,
        content: tweet.content
    }, token);
    
    // 4. Publish
    const response = await publishTweetWithAgent(tweet, auth);
    result.value = response.success 
        ? `Tweet published! ID: ${response.mid}`
        : `Failed: ${response.message}`;
}
</script>
```

## Backend Integration

### Backend Endpoints

The backend provides these endpoints for agent authentication:

#### `add_tweet` (with agentAuth)

Publish a tweet with agent authentication.

**Request:**
```javascript
{
    aid: "app_id",
    ver: "last",
    tweet: JSON.stringify({
        authorId: "user_mimei_id",
        content: "tweet content",
        ...
    }),
    agentAuth: {
        mimeiId: "user_mimei_id",
        timestamp: 1234567890123,
        signature: "base64_signature"
    }
}
```

**Response:**
```javascript
{
    success: true,
    mid: "tweet_mimei_id"
}
```

#### `verify_agent_token`

Verify an agent token without executing the action.

**Request:**
```javascript
{
    aid: "app_id",
    ver: "last",
    agentAuth: {
        mimeiId: "user_mimei_id",
        timestamp: 1234567890123,
        signature: "base64_signature"
    },
    requestData: {
        authorId: "user_mimei_id",
        content: "tweet content"
    }
}
```

**Response:**
```javascript
{
    valid: true,
    mimeiId: "user_mimei_id"
}
```

### Backend Files

- `/TweetBackendApp/add_tweet.js` - Handles agent authentication in tweet creation
- `/TweetBackendApp/verify_agent_token.js` - Standalone token verification

## Security Considerations

### Token Storage

- **Private keys should never be transmitted** - Only the public key and token metadata
- **Store tokens securely** - Use secure storage (Keychain on iOS, secure enclaves)
- **Regenerate tokens periodically** - Rotate keys to limit exposure

### Request Security

- **5-minute request expiration** - Prevents replay attacks
- **Clock skew tolerance** - ±1 minute allowed for client clock differences
- **Signature covers all critical data** - Including timestamp and authorId

### Scope Limiting

Always use the minimum required scope:

```typescript
// Good: Minimal scope
const token = await generateAgentToken('user123', ['post']);

// Avoid: Overly broad scope unless needed
const token = await generateAgentToken('user123', ['post', 'comment', 'like', 'delete']);
```

### Author Verification

The backend verifies that the `authorId` in the tweet matches the `mimeiId` in the token:

```javascript
// This will fail - agent cannot post as different user
const tweet = { authorId: 'different_user', content: '...' };
const auth = { mimeiId: 'user123', ... }; // Mismatch!
```

## Examples

### cURL Example

```bash
# Publish tweet with agent authentication
curl -X POST http://localhost:4800/webapi/RunMApp \
  -H "Content-Type: application/json" \
  -d '{
    "name": "add_tweet",
    "params": {
      "aid": "your_app_id",
      "ver": "last",
      "tweet": "{\"authorId\":\"user123\",\"content\":\"Hello from curl!\"}",
      "agentAuth": {
        "mimeiId": "user123",
        "timestamp": 1234567890123,
        "signature": "base64_encoded_signature"
      }
    }
  }'
```

### Python Example

```python
import base64
import json
import time
from nacl.signing import SigningKey

# Generate keypair
signing_key = SigningKey.generate()
private_key = base64.b64encode(bytes(signing_key)).decode()
public_key = base64.b64encode(bytes(signing_key.verify_key)).decode()

# Create token
token = {
    "version": 1,
    "mimeiId": "user123",
    "privateKey": private_key,
    "publicKey": public_key,
    "createdAt": int(time.time() * 1000),
    "scope": ["post", "comment"]
}

# Sign request
timestamp = int(time.time() * 1000)
data = {
    "authorId": "user123",
    "content": "Hello from Python!",
    "mimeiId": "user123",
    "timestamp": timestamp
}
message = json.dumps(data, sort_keys=True)
signature = signing_key.sign(message.encode(), encoder=nacl.encoding.Base64Encoder)

auth = {
    "mimeiId": "user123",
    "timestamp": timestamp,
    "signature": signature.decode()
}

print(f"Token: {base64.b64encode(json.dumps(token).encode()).decode()}")
print(f"Auth: {json.dumps(auth)}")
```

## Troubleshooting

### "Agent not configured for this user"

The user hasn't set up agent authentication. The public key must be stored in their profile data.

### "Invalid signature"

- Check that data is sorted before signing
- Verify the private key matches the stored public key
- Ensure timestamp is recent (within 5 minutes)

### "Request expired"

The timestamp is too old. Generate a fresh signature with the current time.

### "Agent cannot post as different user"

The `authorId` in the tweet doesn't match the `mimeiId` in the token. They must be the same.

## See Also

- [API Documentation](API.md) - General API documentation
- [Architecture Overview](ARCHITECTURE.md) - System design
- [Backend README](../TweetBackendApp/README.md) - Backend functions

## Changelog

### Version 1.0.0

- Initial agent authentication API
- Ed25519 signature-based authentication
- Token generation and export/import
- Backend verification endpoints
- Demo page at `/agent-auth-demo`
