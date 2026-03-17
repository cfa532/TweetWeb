/**
 * Agent Authentication Utilities
 * 
 * Provides Ed25519 cryptographic signing for AI agent authentication.
 * Allows AI agents to post tweets on behalf of users without requiring passwords.
 * 
 * This module is compatible with the iOS AgentTokenManager implementation.
 * 
 * @module agentAuth
 */

import { useLeitherStore } from '@/stores/leitherStore';

/**
 * Agent Token structure matching iOS implementation
 */
export interface AgentToken {
    version: number;
    mimeiId: string;
    privateKey: string;  // Base64-encoded Ed25519 private key
    publicKey: string;   // Base64-encoded Ed25519 public key
    createdAt: number;   // Unix timestamp in milliseconds
    scope: string[];     // Allowed actions: ["post", "comment", "like"]
}

/**
 * Agent Authentication data to include with requests
 */
export interface AgentAuth {
    mimeiId: string;
    timestamp: number;
    signature: string;   // Base64-encoded Ed25519 signature
}

/**
 * Generate a new Ed25519 keypair for agent authentication
 * @returns Object containing privateKey (base64) and publicKey (base64)
 */
export async function generateKeyPair(): Promise<{ privateKey: string; publicKey: string }> {
    // Use Web Crypto API for Ed25519 key generation
    const keyPair = await crypto.subtle.generateKey(
        {
            name: 'Ed25519',
        } as AlgorithmIdentifier,
        true,  // extractable
        ['sign', 'verify']
    );
    
    // Export keys as base64
    const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
    const publicKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    
    return {
        privateKey: arrayBufferToBase64(privateKeyBuffer),
        publicKey: arrayBufferToBase64(publicKeyBuffer)
    };
}

/**
 * Generate a complete agent token for the given user
 * @param mimeiId - The user's Mimei ID
 * @param scope - Allowed actions (default: ["post", "comment"])
 * @returns A new AgentToken
 */
export async function generateAgentToken(
    mimeiId: string,
    scope: string[] = ['post', 'comment']
): Promise<AgentToken> {
    const keyPair = await generateKeyPair();
    
    return {
        version: 1,
        mimeiId,
        privateKey: keyPair.privateKey,
        publicKey: keyPair.publicKey,
        createdAt: Date.now(),
        scope
    };
}

/**
 * Sign request data with an agent token
 * @param data - The data to sign (typically contains authorId and content)
 * @param token - The agent token containing the private key
 * @returns AgentAuth object with mimeiId, timestamp, and signature
 */
export async function signRequest(
    data: Record<string, any>,
    token: AgentToken
): Promise<AgentAuth> {
    const timestamp = Date.now();
    
    // Create signable data with required fields
    const signableData: Record<string, any> = {
        ...data,
        mimeiId: token.mimeiId,
        timestamp
    };
    
    // Sort keys for consistent JSON serialization (matches iOS behavior)
    const sortedData = sortObjectKeys(signableData);
    const messageString = JSON.stringify(sortedData);
    
    // Sign the message using the private key
    const signature = await signWithPrivateKey(messageString, token.privateKey);
    
    return {
        mimeiId: token.mimeiId,
        timestamp,
        signature
    };
}

/**
 * Verify a signature using the public key (for testing/validation)
 * @param data - The original data that was signed
 * @param auth - The AgentAuth containing signature
 * @param publicKeyBase64 - The base64-encoded public key
 * @returns True if signature is valid
 */
export async function verifySignature(
    data: Record<string, any>,
    auth: AgentAuth,
    publicKeyBase64: string
): Promise<boolean> {
    try {
        // Reconstruct the signed data
        const signableData: Record<string, any> = {
            ...data,
            mimeiId: auth.mimeiId,
            timestamp: auth.timestamp
        };
        
        // Sort keys for consistent JSON serialization
        const sortedData = sortObjectKeys(signableData);
        const messageString = JSON.stringify(sortedData);
        
        // Import the public key
        const publicKeyBuffer = base64ToArrayBuffer(publicKeyBase64);
        const publicKey = await crypto.subtle.importKey(
            'raw',
            publicKeyBuffer,
            { name: 'Ed25519' } as AlgorithmIdentifier,
            false,
            ['verify']
        );
        
        // Verify the signature
        const signatureBuffer = base64ToArrayBuffer(auth.signature);
        const messageBuffer = new TextEncoder().encode(messageString);
        
        return await crypto.subtle.verify(
            { name: 'Ed25519' } as AlgorithmIdentifier,
            publicKey,
            signatureBuffer,
            messageBuffer
        );
    } catch (error) {
        console.error('Signature verification failed:', error);
        return false;
    }
}

/**
 * Export agent token to a portable base64 string
 * @param token - The agent token to export
 * @returns Base64-encoded token string
 */
export function exportToken(token: AgentToken): string {
    const jsonString = JSON.stringify(token);
    return btoa(jsonString);
}

/**
 * Import agent token from a base64 string
 * @param tokenString - Base64-encoded token string
 * @returns The AgentToken or null if invalid
 */
export function importToken(tokenString: string): AgentToken | null {
    try {
        const jsonString = atob(tokenString);
        return JSON.parse(jsonString) as AgentToken;
    } catch (error) {
        console.error('Failed to import token:', error);
        return null;
    }
}

/**
 * Publish a tweet using agent authentication
 * @param tweet - The tweet object to publish
 * @param agentAuth - The agent authentication data
 * @param providerIp - Optional provider IP (will be detected if not provided)
 * @returns Promise resolving to the result with tweet mid
 */
export async function publishTweetWithAgent(
    tweet: any,
    agentAuth: AgentAuth,
    providerIp?: string
): Promise<{ success: boolean; mid?: string; message?: string; error?: any }> {
    const lapi = useLeitherStore();
    
    try {
        // Get provider IP for the author if not provided
        let targetIp = providerIp;
        if (!targetIp) {
            // Try to get provider IP from user data
            const userData = await getUserProviderIp(tweet.authorId);
            if (userData) {
                targetIp = userData;
            } else {
                throw new Error('Could not determine provider IP for author');
            }
        }
        
        // Get client for the target IP
        const client = await lapi.getClient(targetIp);
        
        // Call add_tweet with agentAuth
        const params = {
            aid: lapi.appId,
            ver: 'last',
            tweet: JSON.stringify(tweet),
            agentAuth: agentAuth
        };
        
        const response = await client.RunMApp('add_tweet', params);
        
        if (response && response.success) {
            return {
                success: true,
                mid: response.mid,
                message: 'Tweet published successfully'
            };
        } else {
            return {
                success: false,
                message: response?.message || 'Failed to publish tweet',
                error: response
            };
        }
    } catch (error: any) {
        console.error('Error publishing tweet with agent auth:', error);
        return {
            success: false,
            message: error.message || 'Unknown error occurred',
            error
        };
    }
}

/**
 * Verify agent token with the backend
 * @param agentAuth - The agent authentication data
 * @param requestData - The data that was signed
 * @returns Promise resolving to verification result
 */
export async function verifyAgentTokenWithBackend(
    agentAuth: AgentAuth,
    requestData: Record<string, any>
): Promise<{ valid: boolean; error?: string; mimeiId?: string }> {
    const lapi = useLeitherStore();
    
    try {
        const response = await lapi.client.RunMApp('verify_agent_token', {
            aid: lapi.appId,
            ver: 'last',
            agentAuth: agentAuth,
            requestData: requestData
        });
        
        return response;
    } catch (error: any) {
        console.error('Error verifying agent token:', error);
        return {
            valid: false,
            error: error.message || 'Verification failed'
        };
    }
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Sign a message with a private key
 * @param message - The message string to sign
 * @param privateKeyBase64 - Base64-encoded private key
 * @returns Base64-encoded signature
 */
async function signWithPrivateKey(message: string, privateKeyBase64: string): Promise<string> {
    // Import the private key
    const privateKeyBuffer = base64ToArrayBuffer(privateKeyBase64);
    
    // For Ed25519, we need to handle the key format properly
    // The private key in pkcs8 format includes the public key
    const privateKey = await crypto.subtle.importKey(
        'pkcs8',
        privateKeyBuffer,
        { name: 'Ed25519' } as AlgorithmIdentifier,
        false,
        ['sign']
    );
    
    // Sign the message
    const messageBuffer = new TextEncoder().encode(message);
    const signatureBuffer = await crypto.subtle.sign(
        { name: 'Ed25519' } as AlgorithmIdentifier,
        privateKey,
        messageBuffer
    );
    
    return arrayBufferToBase64(signatureBuffer);
}

/**
 * Sort object keys recursively for consistent JSON serialization
 * This matches the iOS behavior of using .sortedKeys when serializing
 */
function sortObjectKeys(obj: any): any {
    if (obj === null || typeof obj !== 'object') {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(sortObjectKeys);
    }
    const sorted: Record<string, any> = {};
    Object.keys(obj).sort().forEach(key => {
        sorted[key] = sortObjectKeys(obj[key]);
    });
    return sorted;
}

/**
 * Convert ArrayBuffer to Base64 string
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Convert Base64 string to ArrayBuffer
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Get provider IP for a user
 * @param userId - The user's Mimei ID
 * @returns Promise resolving to provider IP or null
 */
async function getUserProviderIp(userId: string): Promise<string | null> {
    const lapi = useLeitherStore();
    
    try {
        // Call get_provider_ips to get available providers
        const response = await lapi.client.RunMApp('get_provider_ips', {
            aid: lapi.appId,
            ver: 'last',
            version: 'v2',
            mid: userId,
            v4only: 'true'
        });
        
        let ipList: string[] = [];
        
        if (Array.isArray(response)) {
            ipList = response;
        } else if (typeof response === 'object' && Array.isArray(response.data)) {
            ipList = response.data;
        } else if (typeof response === 'string') {
            ipList = [response];
        }
        
        if (ipList.length > 0) {
            return ipList[0].trim();
        }
        
        return null;
    } catch (error) {
        console.error('Error getting user provider IP:', error);
        return null;
    }
}

// ============================================================================
// Legacy/Compatibility Functions for NaCl/TweetNaCl usage
// ============================================================================

/**
 * Fallback signing function using NaCl (if available)
 * This can be used if Web Crypto API doesn't support Ed25519
 * Note: Requires nacl or tweetnacl library to be loaded
 */
export function signWithNaCl(
    message: string,
    privateKeyBase64: string,
    nacl: any
): string | null {
    try {
        const privateKeyBytes = base64ToUint8Array(privateKeyBase64);
        const messageBytes = new TextEncoder().encode(message);
        
        // NaCl expects the private key to be 64 bytes (32 seed + 32 public)
        const signature = nacl.sign.detached(messageBytes, privateKeyBytes);
        return uint8ArrayToBase64(signature);
    } catch (error) {
        console.error('NaCl signing failed:', error);
        return null;
    }
}

/**
 * Convert Base64 string to Uint8Array
 */
function base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

/**
 * Convert Uint8Array to Base64 string
 */
function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}
