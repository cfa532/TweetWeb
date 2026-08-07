import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('@/utils/browserNetwork', () => ({
  browserUsableProviderRoutes: (addresses: string[]) => addresses,
  isPublicWebGatewayHost: () => false,
}))

import { nodePool } from '@/utils/nodePool'
import { useTweetStore } from './tweetStore'

const AUTHOR_ID = 'author-with-moved-node'
const NODE_ID = 'access-node-1'
const DEAD_HOST = '125.229.161.122:8080'
const LIVE_HOST = '220.184.34.132:8080'
const CID = 'QmRRfaZJTchh8JVamqcq1NmJHfpSGMrNTDmW1H15GrsPjz'

function cachedPinnedPayload(mediaUrl: string) {
  return {
    cachedAt: Date.now(),
    value: [{
      mid: 'pinned-tweet-1',
      authorId: AUTHOR_ID,
      timestamp: 1,
      content: 'pinned',
      attachments: [{ mid: mediaUrl, type: 'image/jpeg' }],
      author: { mid: AUTHOR_ID, hostIds: [NODE_ID], avatar: `http://${DEAD_HOST}/mm/avatar` },
    }],
  }
}

describe('cached media hosts follow the live provider node', () => {
  beforeEach(() => {
    ;(window as any).hprose = {
      Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
    }
    setActivePinia(createPinia())
    localStorage.clear()
    sessionStorage.clear()
    nodePool.updateNode(NODE_ID, [LIVE_HOST])
  })

  it('re-points a pinned tweet cached against a node that has since moved', () => {
    localStorage.setItem(`pinned_${AUTHOR_ID}`, JSON.stringify(cachedPinnedPayload(`http://${DEAD_HOST}/ipfs/${CID}`)))

    const store = useTweetStore()
    const [tweet] = store.getCachedPinnedTweets(AUTHOR_ID)

    expect(tweet.attachments?.[0].mid).toBe(`http://${LIVE_HOST}/ipfs/${CID}`)
  })

  it('leaves a raw media id for the loader to resolve', () => {
    localStorage.setItem(`pinned_${AUTHOR_ID}`, JSON.stringify(cachedPinnedPayload(CID)))

    const store = useTweetStore()
    const [tweet] = store.getCachedPinnedTweets(AUTHOR_ID)

    expect(tweet.attachments?.[0].mid).toBe(CID)
  })

  it('adopts the current host on an unchanged pinned attachment without replacing it', async () => {
    const store = useTweetStore()
    const cachedTweet: any = {
      mid: 'pinned-tweet-1',
      authorId: AUTHOR_ID,
      timestamp: 1,
      provider: LIVE_HOST,
      attachments: [{ mid: `http://${DEAD_HOST}/ipfs/${CID}`, type: 'image/jpeg' }],
      author: { mid: AUTHOR_ID, providerIp: LIVE_HOST, hostIds: [NODE_ID] },
    }
    store.tweets.push(cachedTweet)
    store.tweetIndex.set(cachedTweet.mid, cachedTweet)
    // Read back through the store so the comparison is against the same
    // reactive proxy the pinned list renders.
    const cachedAttachment = store.tweetIndex.get(cachedTweet.mid)!.attachments![0]

    const pinnedResponse = [{
      timestamp: 99,
      tweet: {
        mid: cachedTweet.mid,
        authorId: AUTHOR_ID,
        timestamp: 1,
        attachments: [{ mid: CID, type: 'image/jpeg' }],
      },
    }]

    store._getUserForProviderRetryAttempt = vi.fn().mockResolvedValue(cachedTweet.author) as any
    store.getUserReadIp = vi.fn().mockResolvedValue(LIVE_HOST) as any
    store.lapi.connectionPool = {
      getConnection: async () => ({ RunMApp: async () => ({ success: true, data: pinnedResponse }) }),
      releaseConnection: () => {},
    } as any

    const [pinned] = await store.loadPinnedTweets(AUTHOR_ID)

    expect(pinned.attachments?.[0]).toBe(cachedAttachment)
    expect(pinned.attachments?.[0].mid).toBe(`http://${LIVE_HOST}/ipfs/${CID}`)
  })
})
