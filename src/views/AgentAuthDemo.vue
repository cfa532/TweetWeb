<script setup lang="ts">
/**
 * AgentAuthDemo Component
 * 
 * A demo/test component for the Agent Authentication API.
 * Demonstrates how to:
 * - Generate agent tokens
 * - Sign requests
 * - Publish tweets with agent authentication
 * 
 * This component is for development/testing purposes.
 */

import { ref, reactive } from 'vue';
import { useAgentTweet } from '@/composables/useAgentTweet';
import { 
    generateAgentToken, 
    exportToken, 
    importToken,
    verifySignature,
    type AgentToken 
} from '@/utils/agentAuth';

// Reactive state
const activeTab = ref<'token' | 'publish' | 'verify'>('token');
const mimeiId = ref('');
const tokenString = ref('');
const importedToken = ref<AgentToken | null>(null);
const generatedToken = ref<AgentToken | null>(null);
const scope = ref(['post', 'comment']);
const verificationResult = ref<{ valid: boolean; message: string } | null>(null);

// Tweet form data
const tweetForm = reactive({
    authorId: '',
    content: '',
    title: '',
    isPrivate: false,
    downloadable: false,
    attachments: [] as any[]
});

// Use the agent tweet composable
const { 
    isPublishing, 
    publishResult, 
    publishTweet,
    signTweetRequest,
    canPublish
} = useAgentTweet();

// Token generation
async function handleGenerateToken() {
    if (!mimeiId.value) {
        alert('Please enter a Mimei ID');
        return;
    }
    
    try {
        const token = await generateAgentToken(mimeiId.value, scope.value);
        generatedToken.value = token;
        tokenString.value = exportToken(token);
        
        // Auto-fill tweet author if empty
        if (!tweetForm.authorId) {
            tweetForm.authorId = mimeiId.value;
        }
    } catch (error) {
        console.error('Token generation failed:', error);
        alert('Failed to generate token: ' + (error as Error).message);
    }
}

// Token import
function handleImportToken() {
    if (!tokenString.value) {
        alert('Please enter a token string');
        return;
    }
    
    const token = importToken(tokenString.value);
    if (token) {
        importedToken.value = token;
        generatedToken.value = token;
        mimeiId.value = token.mimeiId;
        
        // Auto-fill tweet author
        tweetForm.authorId = token.mimeiId;
        
        alert('Token imported successfully!');
    } else {
        alert('Invalid token string');
    }
}

// Copy token to clipboard
async function copyToken() {
    if (tokenString.value) {
        await navigator.clipboard.writeText(tokenString.value);
        alert('Token copied to clipboard!');
    }
}

// Local signature verification test
async function handleLocalVerify() {
    if (!generatedToken.value) {
        alert('Please generate or import a token first');
        return;
    }
    
    const testData = {
        authorId: tweetForm.authorId || generatedToken.value.mimeiId,
        content: tweetForm.content
    };
    
    try {
        const auth = await signTweetRequest(testData, generatedToken.value);
        const isValid = await verifySignature(testData, auth, generatedToken.value.publicKey);
        
        verificationResult.value = {
            valid: isValid,
            message: isValid ? 'Signature is valid!' : 'Signature verification failed!'
        };
    } catch (error) {
        verificationResult.value = {
            valid: false,
            message: 'Verification error: ' + (error as Error).message
        };
    }
}

// Publish tweet with agent auth
async function handlePublishTweet() {
    const token = generatedToken.value || importedToken.value;
    if (!token) {
        alert('Please generate or import a token first');
        return;
    }
    
    if (!tweetForm.authorId) {
        alert('Author ID is required');
        return;
    }
    
    if (!tweetForm.content && !tweetForm.attachments.length) {
        alert('Tweet must have content or attachments');
        return;
    }
    
    // Ensure authorId matches the token
    if (tweetForm.authorId !== token.mimeiId) {
        alert(`Author ID must match the token Mimei ID (${token.mimeiId})`);
        return;
    }
    
    const tweet = {
        authorId: tweetForm.authorId,
        content: tweetForm.content,
        title: tweetForm.title,
        isPrivate: tweetForm.isPrivate,
        downloadable: tweetForm.downloadable,
        attachments: tweetForm.attachments
    };
    
    const result = await publishTweet(tweet, token);
    console.log('Publish result:', result);
}

// Reset form
function resetForm() {
    tweetForm.authorId = '';
    tweetForm.content = '';
    tweetForm.title = '';
    tweetForm.isPrivate = false;
    tweetForm.downloadable = false;
    tweetForm.attachments = [];
}

// Clear all
function clearAll() {
    generatedToken.value = null;
    importedToken.value = null;
    tokenString.value = '';
    mimeiId.value = '';
    verificationResult.value = null;
    resetForm();
}
</script>

<template>
    <div class="agent-auth-demo">
        <div class="card">
            <div class="card-header">
                <h2>🔐 Agent Authentication Demo</h2>
                <p class="text-muted">
                    Test the AI agent authentication API. Generate tokens, sign requests, and publish tweets.
                </p>
            </div>
            
            <div class="card-body">
                <!-- Tab Navigation -->
                <ul class="nav nav-tabs mb-4">
                    <li class="nav-item">
                        <button 
                            class="nav-link" 
                            :class="{ active: activeTab === 'token' }"
                            @click="activeTab = 'token'"
                        >
                            1. Token Management
                        </button>
                    </li>
                    <li class="nav-item">
                        <button 
                            class="nav-link" 
                            :class="{ active: activeTab === 'publish' }"
                            @click="activeTab = 'publish'"
                        >
                            2. Publish Tweet
                        </button>
                    </li>
                    <li class="nav-item">
                        <button 
                            class="nav-link" 
                            :class="{ active: activeTab === 'verify' }"
                            @click="activeTab = 'verify'"
                        >
                            3. Verify
                        </button>
                    </li>
                </ul>
                
                <!-- Token Management Tab -->
                <div v-if="activeTab === 'token'" class="tab-content">
                    <h4>Generate New Token</h4>
                    <div class="mb-3">
                        <label class="form-label">Mimei ID (User ID)</label>
                        <input 
                            v-model="mimeiId" 
                            type="text" 
                            class="form-control"
                            placeholder="Enter your Mimei ID"
                        >
                    </div>
                    
                    <div class="mb-3">
                        <label class="form-label">Scope</label>
                        <div class="form-check">
                            <input 
                                v-model="scope" 
                                type="checkbox" 
                                class="form-check-input" 
                                value="post"
                                id="scope-post"
                            >
                            <label class="form-check-label" for="scope-post">post</label>
                        </div>
                        <div class="form-check">
                            <input 
                                v-model="scope" 
                                type="checkbox" 
                                class="form-check-input" 
                                value="comment"
                                id="scope-comment"
                            >
                            <label class="form-check-label" for="scope-comment">comment</label>
                        </div>
                    </div>
                    
                    <button 
                        @click="handleGenerateToken"
                        class="btn btn-primary me-2"
                    >
                        Generate Token
                    </button>
                    
                    <button 
                        @click="clearAll"
                        class="btn btn-outline-secondary"
                    >
                        Clear All
                    </button>
                    
                    <hr class="my-4">
                    
                    <h4>Import/Export Token</h4>
                    <div class="mb-3">
                        <label class="form-label">Token String (Base64)</label>
                        <textarea 
                            v-model="tokenString" 
                            class="form-control"
                            rows="4"
                            placeholder="Paste token string here or generate one above"
                        ></textarea>
                    </div>
                    
                    <button 
                        @click="handleImportToken"
                        class="btn btn-outline-primary me-2"
                    >
                        Import Token
                    </button>
                    
                    <button 
                        v-if="tokenString"
                        @click="copyToken"
                        class="btn btn-outline-secondary"
                    >
                        Copy Token
                    </button>
                    
                    <!-- Token Details -->
                    <div v-if="generatedToken" class="mt-4">
                        <h5>Token Details:</h5>
                        <table class="table table-sm">
                            <tbody>
                                <tr>
                                    <td><strong>Version</strong></td>
                                    <td>{{ generatedToken.version }}</td>
                                </tr>
                                <tr>
                                    <td><strong>Mimei ID</strong></td>
                                    <td>{{ generatedToken.mimeiId }}</td>
                                </tr>
                                <tr>
                                    <td><strong>Created At</strong></td>
                                    <td>{{ new Date(generatedToken.createdAt).toLocaleString() }}</td>
                                </tr>
                                <tr>
                                    <td><strong>Scope</strong></td>
                                    <td>{{ generatedToken.scope.join(', ') }}</td>
                                </tr>
                                <tr>
                                    <td><strong>Public Key</strong></td>
                                    <td>
                                        <code>{{ generatedToken.publicKey.substring(0, 50) }}...</code>
                                    </td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
                
                <!-- Publish Tweet Tab -->
                <div v-if="activeTab === 'publish'" class="tab-content">
                    <div v-if="!generatedToken && !importedToken" class="alert alert-warning">
                        Please generate or import a token first in the Token Management tab.
                    </div>
                    
                    <div v-else>
                        <div class="alert alert-info">
                            Token loaded for: <strong>{{ (generatedToken || importedToken)?.mimeiId }}</strong>
                        </div>
                        
                        <h4>Compose Tweet</h4>
                        
                        <div class="mb-3">
                            <label class="form-label">Author ID</label>
                            <input 
                                v-model="tweetForm.authorId" 
                                type="text" 
                                class="form-control"
                                placeholder="Enter author ID"
                            >
                            <small class="form-text text-muted">
                                Must match the token's Mimei ID
                            </small>
                        </div>
                        
                        <div class="mb-3">
                            <label class="form-label">Title (Optional)</label>
                            <input 
                                v-model="tweetForm.title" 
                                type="text" 
                                class="form-control"
                                placeholder="Enter tweet title"
                            >
                        </div>
                        
                        <div class="mb-3">
                            <label class="form-label">Content</label>
                            <textarea 
                                v-model="tweetForm.content" 
                                class="form-control"
                                rows="4"
                                placeholder="What's happening?"
                            ></textarea>
                        </div>
                        
                        <div class="mb-3 form-check">
                            <input 
                                v-model="tweetForm.isPrivate" 
                                type="checkbox" 
                                class="form-check-input"
                                id="isPrivate"
                            >
                            <label class="form-check-label" for="isPrivate">Private Tweet</label>
                        </div>
                        
                        <div class="mb-3 form-check">
                            <input 
                                v-model="tweetForm.downloadable" 
                                type="checkbox" 
                                class="form-check-input"
                                id="downloadable"
                            >
                            <label class="form-check-label" for="downloadable">Allow Downloads</label>
                        </div>
                        
                        <div class="d-flex gap-2">
                            <button 
                                @click="handlePublishTweet"
                                class="btn btn-primary"
                                :disabled="!canPublish || isPublishing"
                            >
                                <span v-if="isPublishing" class="spinner-border spinner-border-sm me-2"></span>
                                {{ isPublishing ? 'Publishing...' : 'Publish Tweet' }}
                            </button>
                            
                            <button 
                                @click="resetForm"
                                class="btn btn-outline-secondary"
                            >
                                Reset
                            </button>
                        </div>
                        
                        <!-- Publish Result -->
                        <div v-if="publishResult" class="mt-4">
                            <div 
                                class="alert"
                                :class="publishResult.success ? 'alert-success' : 'alert-danger'"
                            >
                                <strong>{{ publishResult.success ? '✅ Success!' : '❌ Failed!' }}</strong>
                                <p class="mb-0">{{ publishResult.message }}</p>
                                <div v-if="publishResult.mid" class="mt-2">
                                    <strong>Tweet ID:</strong> 
                                    <code>{{ publishResult.mid }}</code>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Verify Tab -->
                <div v-if="activeTab === 'verify'" class="tab-content">
                    <div v-if="!generatedToken" class="alert alert-warning">
                        Please generate or import a token first.
                    </div>
                    
                    <div v-else>
                        <h4>Local Signature Verification</h4>
                        <p class="text-muted">
                            Test signature verification locally without calling the backend.
                            This validates that the signing algorithm works correctly.
                        </p>
                        
                        <button 
                            @click="handleLocalVerify"
                            class="btn btn-outline-primary"
                        >
                            Test Local Verification
                        </button>
                        
                        <div v-if="verificationResult" class="mt-3">
                            <div 
                                class="alert"
                                :class="verificationResult.valid ? 'alert-success' : 'alert-danger'"
                            >
                                <strong>{{ verificationResult.valid ? '✅ Valid' : '❌ Invalid' }}</strong>
                                <p class="mb-0">{{ verificationResult.message }}</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
        
        <!-- API Documentation Reference -->
        <div class="card mt-4">
            <div class="card-header">
                <h5>📚 API Reference</h5>
            </div>
            <div class="card-body">
                <h6>Agent Token Structure</h6>
                <pre class="bg-light p-3 rounded"><code>{
  "version": 1,
  "mimeiId": "user_mimei_id",
  "privateKey": "base64_encoded_ed25519_private_key",
  "publicKey": "base64_encoded_ed25519_public_key",
  "createdAt": 1234567890123,
  "scope": ["post", "comment"]
}</code></pre>
                
                <h6>AgentAuth Request Structure</h6>
                <pre class="bg-light p-3 rounded"><code>{
  "mimeiId": "user_mimei_id",
  "timestamp": 1234567890123,
  "signature": "base64_encoded_ed25519_signature"
}</code></pre>
                
                <h6>Signed Data Format</h6>
                <pre class="bg-light p-3 rounded"><code>// The following data is sorted by keys and JSON.stringify'd for signing:
{
  "authorId": "user_mimei_id",
  "content": "tweet content",
  "mimeiId": "user_mimei_id",
  "timestamp": 1234567890123
}</code></pre>
            </div>
        </div>
    </div>
</template>

<style scoped>
.agent-auth-demo {
    max-width: 800px;
    margin: 0 auto;
    padding: 20px;
}

.nav-tabs .nav-link {
    cursor: pointer;
}

.tab-content {
    padding-top: 20px;
}

pre {
    overflow-x: auto;
}

code {
    font-family: 'Courier New', monospace;
}
</style>
