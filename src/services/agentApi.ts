/**
 * Agent API Service
 *
 * Provides a standalone API for publishing tweets with media attachments
 * using agent authentication (Ed25519 signed tokens).
 *
 * Full flow for a caller with text + media files:
 *
 * 1. Import/parse the agent token
 * 2. Upload each media file via agentUploadFile() → returns CID per file
 * 3. Build the tweet object with attachments (CIDs from step 2)
 * 4. Sign the request via signRequest()
 * 5. Publish via agentPublishTweet()
 *
 * @example
 * ```typescript
 * import { agentUploadFile, agentPublishTweet } from '@/services/agentApi';
 * import { signRequest, importToken } from '@/utils/agentAuth';
 *
 * // 1. Parse token
 * const token = importToken(base64TokenString);
 *
 * // 2. Upload media files
 * const file1 = await fetch('/path/to/image.jpg').then(r => r.arrayBuffer());
 * const attachment1 = await agentUploadFile(token.mimeiId, file1, 'image.jpg', 'image/jpeg');
 *
 * // 3. Build tweet
 * const tweet = {
 *     authorId: token.mimeiId,
 *     content: 'Hello from agent!',
 *     attachments: [attachment1]
 * };
 *
 * // 4. Sign
 * const agentAuth = await signRequest(
 *     { authorId: tweet.authorId, content: tweet.content },
 *     token
 * );
 *
 * // 5. Publish
 * const result = await agentPublishTweet(tweet, agentAuth);
 * ```
 */

import { useLeitherStore } from '@/stores/leitherStore';
import { getMediaType } from '@/utils/uploadUtils';
import type { AgentAuth } from '@/utils/agentAuth';

const CHUNK_SIZE = 1024 * 1024; // 1MB chunks, matching iOS and EditorModal

export interface AgentTweet {
    authorId: string;
    content: string;
    title?: string;
    isPrivate?: boolean;
    downloadable?: boolean;
    attachments?: MimeiFileType[];
}

export interface AgentPublishResult {
    success: boolean;
    mid?: string;
    message?: string;
    error?: any;
}

/**
 * Resolve provider IP for a given user (mimeiId).
 * Queries the Leither network to find which node hosts this user.
 */
async function resolveProviderIp(mimeiId: string): Promise<string> {
    const lapi = useLeitherStore();

    const response = await lapi.client.RunMApp('get_provider_ips', {
        aid: lapi.appId,
        ver: 'last',
        version: 'v2',
        mid: mimeiId,
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

    if (ipList.length === 0) {
        throw new Error(`No provider found for user ${mimeiId}`);
    }
    return ipList[0].trim();
}

/**
 * Upload a file to IPFS on the user's Leither node.
 *
 * The file is uploaded in 1MB chunks via the existing upload_ipfs backend,
 * then finalized to get an IPFS CID. Returns a MimeiFileType attachment
 * object ready to include in a tweet.
 *
 * @param mimeiId - The user's Mimei ID (to resolve their provider node)
 * @param data - File content as ArrayBuffer
 * @param fileName - Original file name (e.g. 'photo.jpg')
 * @param mimeType - MIME type (e.g. 'image/jpeg')
 * @param providerIp - Optional provider IP (auto-resolved if omitted)
 * @param onProgress - Optional callback with progress 0-100
 * @returns MimeiFileType attachment with CID populated in .mid
 */
export async function agentUploadFile(
    mimeiId: string,
    data: ArrayBuffer,
    fileName: string,
    mimeType: string,
    providerIp?: string,
    onProgress?: (percent: number) => void
): Promise<MimeiFileType> {
    const lapi = useLeitherStore();
    const ip = providerIp || await resolveProviderIp(mimeiId);
    const client = await lapi.getClient(ip);

    const originalTimeout = client.timeout;
    client.timeout = 10 * 60 * 1000; // 10 min for large files

    try {
        let fsid: string | null = null;
        let offset = 0;

        // Upload in chunks
        while (offset < data.byteLength) {
            const end = Math.min(offset + CHUNK_SIZE, data.byteLength);
            const chunk = new Uint8Array(data.slice(offset, end));

            const request: any = {
                aid: lapi.appId,
                ver: 'last',
                version: 'v2',
                offset
            };
            if (fsid) {
                request.fsid = fsid;
            }

            const response = await client.RunMApp('upload_ipfs', request, [chunk]);

            // Parse response (v2 format: {success, data} or legacy string)
            if (response && typeof response === 'object') {
                if (response.success === false) {
                    throw new Error(response.message || 'Chunk upload failed');
                }
                fsid = response.data;
            } else if (typeof response === 'string') {
                fsid = response;
            } else {
                throw new Error(`Unexpected upload response: ${typeof response}`);
            }

            offset = end;
            onProgress?.(Math.floor((offset / data.byteLength) * 95)); // 0-95%
        }

        if (!fsid) {
            throw new Error('No file ID returned from server');
        }

        // Finalize — get IPFS CID
        const finalResponse = await client.RunMApp('upload_ipfs', {
            aid: lapi.appId,
            ver: 'last',
            version: 'v2',
            offset,
            fsid,
            finished: 'true'
        });

        let cid: string | null = null;
        if (finalResponse && typeof finalResponse === 'object') {
            if (finalResponse.success === true && finalResponse.data) {
                cid = finalResponse.data;
            } else if (finalResponse.cid) {
                cid = finalResponse.cid;
            }
        } else if (typeof finalResponse === 'string') {
            cid = finalResponse;
        }

        if (!cid) {
            throw new Error('No CID returned from finalization');
        }

        onProgress?.(100);

        return {
            mid: cid,
            type: getMediaType(mimeType, fileName),
            size: data.byteLength,
            fileName,
            timestamp: Date.now()
        };
    } finally {
        client.timeout = originalTimeout;
        lapi.releaseClient(ip, client);
    }
}

/**
 * Publish a tweet using agent authentication.
 *
 * Calls add_tweet on the author's Leither node with the agentAuth parameter.
 * The backend verifies the Ed25519 signature and creates the tweet.
 *
 * Attachments must already be uploaded (CIDs obtained via agentUploadFile).
 *
 * @param tweet - Tweet with content and pre-uploaded attachments
 * @param agentAuth - Signed agent authentication (from signRequest)
 * @param providerIp - Optional provider IP (auto-resolved if not provided)
 */
export async function agentPublishTweet(
    tweet: AgentTweet,
    agentAuth: AgentAuth,
    providerIp?: string
): Promise<AgentPublishResult> {
    const lapi = useLeitherStore();

    try {
        const ip = providerIp || await resolveProviderIp(tweet.authorId);
        const client = await lapi.getClient(ip);

        const result = await client.RunMApp('add_tweet', {
            aid: lapi.appId,
            ver: 'last',
            tweet: JSON.stringify(tweet),
            agentAuth
        });

        if (result && result.success) {
            return { success: true, mid: result.mid };
        }
        return {
            success: false,
            message: result?.message || 'Backend returned failure',
            error: result
        };
    } catch (error: any) {
        return {
            success: false,
            message: error.message || 'Failed to publish tweet',
            error
        };
    }
}

/**
 * Publish a comment using agent authentication.
 *
 * @param comment - The comment content (as a tweet-like object)
 * @param parentTweetId - The ID of the tweet being commented on
 * @param agentAuth - Signed agent authentication
 * @param providerIp - Optional provider IP
 */
export async function agentPublishComment(
    comment: AgentTweet,
    parentTweetId: string,
    agentAuth: AgentAuth,
    providerIp?: string
): Promise<AgentPublishResult> {
    const lapi = useLeitherStore();

    try {
        const ip = providerIp || await resolveProviderIp(comment.authorId);
        const client = await lapi.getClient(ip);

        const result = await client.RunMApp('add_comment', {
            aid: lapi.appId,
            ver: 'last',
            tweetid: parentTweetId,
            comment: JSON.stringify(comment),
            userid: comment.authorId,
            agentAuth
        });

        if (result && result.success) {
            return { success: true, mid: result.mid };
        }
        return {
            success: false,
            message: result?.message || 'Backend returned failure',
            error: result
        };
    } catch (error: any) {
        return {
            success: false,
            message: error.message || 'Failed to publish comment',
            error
        };
    }
}
