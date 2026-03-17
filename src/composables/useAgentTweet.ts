/**
 * Agent Tweet Composable
 * 
 * Provides reactive state and methods for publishing tweets using agent authentication.
 * This is an alternative to session-based authentication for AI agents.
 * 
 * @example
 * ```vue
 * <script setup>
 * import { useAgentTweet } from '@/composables/useAgentTweet';
 * 
 * const { 
 *   isPublishing, 
 *   publishResult, 
 *   publishTweet,
 *   generateAndExportToken 
 * } = useAgentTweet();
 * 
 * async function handlePublish() {
 *   const result = await publishTweet(tweetData, agentToken);
 *   console.log(result);
 * }
 * </script>
 * ```
 */

import { ref, computed, type Ref, type ComputedRef } from 'vue';
import { useLeitherStore } from '@/stores/leitherStore';
import {
    signRequest,
    verifyAgentTokenWithBackend,
    generateAgentToken,
    exportToken,
    importToken,
    type AgentToken,
    type AgentAuth
} from '@/utils/agentAuth';
import { agentPublishTweet } from '@/services/agentApi';

export interface PublishResult {
    success: boolean;
    mid?: string;
    message?: string;
    error?: any;
}

export interface UseAgentTweetReturn {
    // State
    isPublishing: Ref<boolean>;
    publishResult: Ref<PublishResult | null>;
    lastAgentAuth: Ref<AgentAuth | null>;

    // Computed
    canPublish: ComputedRef<boolean>;

    // Methods
    publishTweet: (tweet: any, token: AgentToken) => Promise<PublishResult>;
    signTweetRequest: (tweet: any, token: AgentToken) => Promise<AgentAuth>;
    verifyToken: (auth: AgentAuth, tweetData: any) => Promise<{ valid: boolean; error?: string; mimeiId?: string }>;
    generateAndExportToken: (mimeiId: string, scope?: string[]) => Promise<{ token: AgentToken; tokenString: string }>;
    importTokenString: (tokenString: string) => AgentToken | null;
    clearResult: () => void;
}

/**
 * Composable for agent-authenticated tweet publishing
 * @returns UseAgentTweetReturn - Reactive state and methods
 */
export function useAgentTweet(): UseAgentTweetReturn {
    const lapi = useLeitherStore();
    
    // Reactive state
    const isPublishing = ref(false);
    const publishResult = ref<PublishResult | null>(null);
    const lastAgentAuth = ref<AgentAuth | null>(null);
    
    // Computed
    const canPublish = computed(() => !isPublishing.value);
    
    /**
     * Sign a tweet request with an agent token
     * @param tweet - The tweet object to sign
     * @param token - The agent token
     * @returns The AgentAuth object
     */
    async function signTweetRequest(tweet: any, token: AgentToken): Promise<AgentAuth> {
        // Create the data object that will be signed
        // This must match the structure expected by the backend
        const signData = {
            authorId: tweet.authorId,
            content: tweet.content || '',
            title: tweet.title || ''
        };
        
        const agentAuth = await signRequest(signData, token);
        lastAgentAuth.value = agentAuth;
        return agentAuth;
    }
    
    /**
     * Publish a tweet using agent authentication
     * @param tweet - The tweet object to publish
     * @param token - The agent token for signing
     * @returns PublishResult with success status and tweet mid
     */
    async function publishTweet(tweet: any, token: AgentToken): Promise<PublishResult> {
        isPublishing.value = true;
        publishResult.value = null;
        
        try {
            // Validate tweet data
            if (!tweet.authorId) {
                throw new Error('Tweet authorId is required');
            }
            
            if (!tweet.content && !tweet.attachments?.length) {
                throw new Error('Tweet must have content or attachments');
            }
            
            // Sign the request
            const agentAuth = await signTweetRequest(tweet, token);
            
            // Publish the tweet via agent API service
            const result = await agentPublishTweet(tweet, agentAuth);
            
            publishResult.value = result;
            return result;
            
        } catch (error: any) {
            const errorResult: PublishResult = {
                success: false,
                message: error.message || 'Failed to publish tweet',
                error
            };
            publishResult.value = errorResult;
            return errorResult;
            
        } finally {
            isPublishing.value = false;
        }
    }
    
    /**
     * Verify an agent token with the backend
     * @param auth - The agent authentication data
     * @param tweetData - The original tweet data that was signed
     * @returns Verification result
     */
    async function verifyToken(
        auth: AgentAuth, 
        tweetData: any
    ): Promise<{ valid: boolean; error?: string; mimeiId?: string }> {
        return await verifyAgentTokenWithBackend(auth, tweetData);
    }
    
    /**
     * Generate a new agent token and export it as a string
     * @param mimeiId - The user's Mimei ID
     * @param scope - Allowed actions (default: ["post", "comment"])
     * @returns Object containing the token and its string representation
     */
    async function generateAndExportToken(
        mimeiId: string,
        scope: string[] = ['post', 'comment']
    ): Promise<{ token: AgentToken; tokenString: string }> {
        const token = await generateAgentToken(mimeiId, scope);
        const tokenString = exportToken(token);
        return { token, tokenString };
    }
    
    /**
     * Import a token from its string representation
     * @param tokenString - Base64-encoded token string
     * @returns The AgentToken or null if invalid
     */
    function importTokenString(tokenString: string): AgentToken | null {
        return importToken(tokenString);
    }
    
    /**
     * Clear the publish result
     */
    function clearResult(): void {
        publishResult.value = null;
    }
    
    return {
        // State
        isPublishing,
        publishResult,
        lastAgentAuth,
        
        // Computed
        canPublish,
        
        // Methods
        publishTweet,
        signTweetRequest,
        verifyToken,
        generateAndExportToken,
        importTokenString,
        clearResult
    };
}
