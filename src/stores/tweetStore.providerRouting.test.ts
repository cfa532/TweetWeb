import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const browserUsableProviderRoutes = vi.hoisted(() => vi.fn((addresses: string[]) =>
  addresses.filter(address => address.startsWith('220.')),
))

vi.mock('@/utils/browserNetwork', () => ({ browserUsableProviderRoutes }))

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
    expect(store.isServerHealthyWithTimeout).toHaveBeenCalledWith('220.184.34.132:8002', 3000)
  })
})
