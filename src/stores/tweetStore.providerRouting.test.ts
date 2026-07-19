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
    expect(store.isServerHealthyWithTimeout).toHaveBeenCalledWith('220.184.34.132:8002', 3000, false)
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
