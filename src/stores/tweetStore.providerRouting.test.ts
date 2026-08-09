import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const browserUsableProviderRoutes = vi.hoisted(() => vi.fn((addresses: string[]) =>
  addresses.filter(address => address.startsWith('220.')),
))

vi.mock('@/utils/browserNetwork', () => ({
  browserUsableProviderRoutes,
  isPublicWebGatewayHost: () => false,
}))

import { useTweetStore } from './tweetStore'
import { nodePool } from '@/utils/nodePool'

/** IP lists passed to the get_tweet races only — the author lookup races too. */
function getTweetRaces(store: any, tweetId: string): string[][] {
  return store.raceProviderIps.mock.calls
    .filter((call: any[]) => call[2] === `tweet ${tweetId}`)
    .map((call: any[]) => call[0])
}

describe('tweetStore public provider routing', () => {
  beforeEach(() => {
    ;(window as any).hprose = {
      Client: { create: () => ({ timeout: 0, useService: () => ({}) }) },
    }
    setActivePinia(createPinia())
    sessionStorage.clear()
    browserUsableProviderRoutes.mockClear()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('filters browser-blocked routes before health checking all public candidates', async () => {
    const store = useTweetStore()
    store.lapi.client.RunMApp = vi.fn().mockResolvedValue([
      '100.79.13.15:8002',
      '100.89.71.56:8080',
      '220.184.34.132:8002',
    ])
    store.isServerHealthyWithTimeout = vi.fn().mockResolvedValue(true)

    await expect(store._resolveProviderIps('user-1', true, false))
      .resolves.toEqual(['220.184.34.132:8002'])
    expect(browserUsableProviderRoutes).toHaveBeenCalledWith([
      '100.79.13.15:8002',
      '100.89.71.56:8080',
      '220.184.34.132:8002',
    ], window.location.hostname)
    expect(store.isServerHealthyWithTimeout).toHaveBeenCalledTimes(1)
    expect(store.isServerHealthyWithTimeout).toHaveBeenCalledWith('220.184.34.132:8002', 6000, false)
  })

  it('keeps one standby route behind the probe winner', async () => {
    const store = useTweetStore()
    const fastIp = '220.0.0.1:8002'
    const standbyIp = '220.184.34.132:8002'
    const thirdIp = '220.184.34.133:8002'
    store.lapi.client.RunMApp = vi.fn().mockResolvedValue([standbyIp, fastIp, thirdIp])
    store.isServerHealthyWithTimeout = vi.fn(async (ip: string) => ip === fastIp) as any

    // Winner first, since getProviderIp() takes ips[0]. Exactly one alternate
    // follows: answering a HEAD fastest is not the same as being able to serve
    // this mid, but every extra entry becomes a real 15s RPC at racing callers.
    await expect(store._resolveProviderIps('multi-route', true, false))
      .resolves.toEqual([fastIp, standbyIp])
  })

  it('never offers a standby whose probe already failed', async () => {
    const store = useTweetStore()
    const fastIp = '220.0.0.1:8002'
    const deadIp = '220.184.34.132:8002'
    store.lapi.client.RunMApp = vi.fn().mockResolvedValue([deadIp, fastIp])
    store.healthCheckCache.set(deadIp, { isHealthy: false, timestamp: Date.now() })
    store.isServerHealthyWithTimeout = vi.fn(async (ip: string) => ip === fastIp) as any

    await expect(store._resolveProviderIps('one-dead-route', true, false))
      .resolves.toEqual([fastIp])
  })

  it('returns every pooled route so the standby survives a cache hit', async () => {
    const store = useTweetStore()
    const mid = 'pooled-author'
    const deadEndIp = '220.0.0.1:8002'
    const holdingIp = '220.184.34.132:8002'
    nodePool.updateNode(mid, [deadEndIp, holdingIp])
    store.isServerHealthyWithTimeout = vi.fn().mockResolvedValue(true)
    store.lapi.client.RunMApp = vi.fn()

    try {
      // The standby _resolveProviderIps kept is only useful if reading the pool
      // hands it back. Returning ips[0] alone meant a probe winner that answers
      // HEAD but serves nothing cost a failed RPC and a full re-discovery to
      // reach the node already cached beside it.
      await expect(store.getProviderIps(mid, true, false))
        .resolves.toEqual([deadEndIp, holdingIp])
      expect(store.lapi.client.RunMApp).not.toHaveBeenCalled()
    } finally {
      nodePool.invalidate(mid)
    }
  })

  it('reads a cached tweet through the node that served it', async () => {
    const store = useTweetStore()
    const tweetId = 'cached-tweet'
    const authorId = 'cached-author'
    const deadEndIp = '220.0.0.1:8002'
    const servedByIp = '220.184.34.132:8002'

    // What a prior fetch wrote: the winning route travels with the tweet.
    sessionStorage.setItem(tweetId, JSON.stringify({
      mid: tweetId,
      authorId,
      provider: servedByIp,
      author: { mid: authorId, username: 'Author', hostIds: ['host-1'], timestamp: 0 },
    }))
    // The author's list still leads with a node that answers HEAD and serves nothing.
    store.getProviderIp = vi.fn(async () => deadEndIp) as any
    store.isServerHealthyWithTimeout = vi.fn().mockResolvedValue(true)

    const cached = await store.fetchTweet(tweetId, authorId)

    // tweet.provider is what loadComments builds its client from. Re-deriving it
    // from the author sent get_comments to a node that answered 0 comments on
    // every reload, while the tweet's own attachments still pointed at the node
    // that had it.
    expect(cached?.provider).toBe(servedByIp)
    expect(store.getProviderIp).not.toHaveBeenCalled()
  })

  it('rejects a provider that answers null so the race can keep going', async () => {
    const store = useTweetStore()
    const tweetId = 'tweet-disclaimed'
    const deadIp = '220.0.0.1:8002'
    let tweetApiCall: ((ip: string, client: any) => Promise<unknown>) | undefined

    store.getProviderIps = vi.fn(async () => [deadIp]) as any
    store.raceProviderIps = vi.fn(async (ips: string[], apiCall: any, context: string) => {
      if (context === `tweet ${tweetId}`) tweetApiCall = apiCall
      return null
    }) as any

    await store.fetchTweet(tweetId, undefined, true)

    expect(tweetApiCall).toBeDefined()
    // "I am not a provider for this tweet" must reject rather than win with a
    // null payload, or the first node to disclaim the tweet beats one that has
    // it — and the truthy {result: null} would skip the author fallback too.
    await expect(tweetApiCall!(deadIp, { RunMApp: vi.fn().mockResolvedValue(null) }))
      .rejects.toThrow(/no data/)
    await expect(tweetApiCall!(deadIp, { RunMApp: vi.fn().mockResolvedValue({ mid: tweetId }) }))
      .resolves.toEqual({ mid: tweetId })
  })

  it('rechecks a cached unhealthy provider during an explicit refresh', async () => {
    const store = useTweetStore()
    const providerIp = '220.184.34.132:8002'
    store.lapi.client.RunMApp = vi.fn().mockResolvedValue([providerIp])
    store.healthCheckCache.set(providerIp, { isHealthy: false, timestamp: Date.now() })
    const fetchMock = vi.fn().mockResolvedValue({})
    vi.stubGlobal('fetch', fetchMock)

    await expect(store._resolveProviderIps('user-refresh', true, true))
      .resolves.toEqual([providerIp])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps a share URL strict: an unanswered probe still fails the public lookup', async () => {
    const store = useTweetStore()
    store.lapi.client.RunMApp = vi.fn().mockResolvedValue(['220.184.34.132:8002'])
    store.isServerHealthyWithTimeout = vi.fn().mockResolvedValue(false)

    await expect(store._resolveProviderIps('share-strict', true, true))
      .rejects.toThrow(/All provider health checks failed/)
  })

  it('races unverified routes for a read when no candidate answers the probe', async () => {
    const store = useTweetStore()
    const providerIp = '220.184.34.132:8002'
    store.lapi.client.RunMApp = vi.fn().mockResolvedValue([providerIp])
    // A cold node that has not woken up yet: the 3s probe reports unhealthy.
    store.isServerHealthyWithTimeout = vi.fn().mockResolvedValue(false)

    await expect(store.getProviderIps('cold-tweet', true, false)).resolves.toEqual([providerIp])
  })

  it('lets an unhealthy verdict expire long before a healthy one', () => {
    const store = useTweetStore()
    const now = Date.now()
    store.healthCheckCache.set('cold-ip', { isHealthy: false, timestamp: now - 5 * 60 * 1000 })
    store.healthCheckCache.set('warm-ip', { isHealthy: true, timestamp: now - 5 * 60 * 1000 })

    expect(store.getFreshHealthStatus('cold-ip')).toBeUndefined()
    expect(store.getFreshHealthStatus('warm-ip')).toBe(true)
  })

  it('keeps unverified node routes instead of taking a fetch-failure cooldown', async () => {
    const store = useTweetStore()
    const nodeIp = '220.184.34.132:8002'
    store.lapi.client.RunMApp = vi.fn().mockResolvedValue([nodeIp])
    store.isServerHealthyWithTimeout = vi.fn().mockResolvedValue(false)

    await expect(store.getNodeIpByHostId('cold-node')).resolves.toBe(nodeIp)
    expect(store._resourceFetchFailures.get('cold-node')).toBeUndefined()
  })

  it('reads through the author node and never touches the tweet mid', async () => {
    const store = useTweetStore()
    const tweetId = 'tweet-with-known-author'
    const authorId = 'author-with-routes'
    const authorIp = '220.184.34.132:8002'
    const tweetOwnIp = '220.0.0.9:8002'

    store.getProviderIps = vi.fn(async (mid: string) => (mid === authorId ? [authorIp] : [tweetOwnIp])) as any
    store.raceProviderIps = vi.fn(async (ips: string[]) => ({
      result: { mid: tweetId, authorId, timestamp: 1, content: 'hi' },
      ip: ips[0],
    })) as any

    const tweet = await store.fetchTweet(tweetId, authorId, true)

    expect(tweet?.mid).toBe(tweetId)
    // The author's nodes serve the author's tweets, so a known author settles it:
    // the tweet's own provider list is never resolved.
    expect(getTweetRaces(store, tweetId)).toEqual([[authorIp]])
    expect(store.getProviderIps).not.toHaveBeenCalledWith(tweetId, expect.anything(), expect.anything())
  })

  it("falls back to the tweet's own providers when the author nodes come up empty", async () => {
    const store = useTweetStore()
    const tweetId = 'tweet-not-on-author-node'
    const authorId = 'author-stale'
    const staleAuthorIp = '220.0.0.1:8002'
    const tweetOwnIp = '220.184.34.132:8002'

    store.getProviderIps = vi.fn(async (mid: string) => (mid === authorId ? [staleAuthorIp] : [tweetOwnIp])) as any
    store.raceProviderIps = vi.fn(async (ips: string[]) =>
      ips[0] === tweetOwnIp
        ? { result: { mid: tweetId, authorId, timestamp: 1, content: 'hi' }, ip: tweetOwnIp }
        : null,
    ) as any

    const tweet = await store.fetchTweet(tweetId, authorId, true)

    expect(tweet?.mid).toBe(tweetId)
    // Author first, then the tweet's own providers — not a give-up in between.
    expect(getTweetRaces(store, tweetId)).toEqual([[staleAuthorIp], [tweetOwnIp]])
  })

  it('resolves the tweet mid directly when the caller has no author', async () => {
    const store = useTweetStore()
    const tweetId = 'tweet-without-author'
    const tweetOwnIp = '220.184.34.132:8002'

    store.getProviderIps = vi.fn(async () => [tweetOwnIp]) as any
    store.raceProviderIps = vi.fn(async (ips: string[]) => ({
      result: { mid: tweetId, authorId: 'someone', timestamp: 1, content: 'hi' },
      ip: ips[0],
    })) as any

    const tweet = await store.fetchTweet(tweetId, undefined, true)

    expect(tweet?.mid).toBe(tweetId)
    expect(getTweetRaces(store, tweetId)).toEqual([[tweetOwnIp]])
  })

  it('clears remembered failures so a user retry does not replay them', async () => {
    const store = useTweetStore()
    const tweetId = 'retried-tweet'
    const goodIp = '220.184.34.132:8002'

    store.healthCheckCache.set('220.0.0.1:8002', { isHealthy: false, timestamp: Date.now() })
    store.healthCheckCache.set(goodIp, { isHealthy: true, timestamp: Date.now() })
    store._recordFetchFailure(tweetId)

    store.clearRouteFailures([tweetId, undefined])

    expect(store.healthCheckCache.has('220.0.0.1:8002')).toBe(false)
    // A working route is still worth remembering.
    expect(store.healthCheckCache.get(goodIp)?.isHealthy).toBe(true)
    expect(store._resourceFetchFailures.get(tweetId)).toBeUndefined()
  })

  it('counts one failed node resolution once when concurrent callers share it', async () => {
    const store = useTweetStore()
    const hostId = 'shared-failing-node'
    store._resolveNodeIps = vi.fn().mockResolvedValue([])

    await Promise.all([
      store.getNodeIpByHostId(hostId),
      store.getNodeIpByHostId(hostId),
      store.getNodeIpByHostId(hostId),
    ])

    expect(store._resourceFetchFailures.get(hostId)?.count).toBe(1)
    expect(store._resolveNodeIps).toHaveBeenCalledTimes(1)
  })
})
