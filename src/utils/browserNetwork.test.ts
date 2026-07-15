import { describe, expect, it } from 'vitest'
import { browserUsableProviderRoutes, isPrivateBrowserHost } from './browserNetwork'

describe('browser provider route eligibility', () => {
  it('keeps later public routes and rejects private routes from a public origin', () => {
    expect(browserUsableProviderRoutes([
      '100.79.13.15:8002',
      '100.89.71.56:8080',
      '192.168.5.4:8080',
      '220.184.34.132:8002',
    ], 'dl.dtweet.com')).toEqual(['220.184.34.132:8002'])
  })

  it('retains Tailscale routes when the page itself is on the tailnet', () => {
    expect(browserUsableProviderRoutes([
      '100.79.13.15:8002',
      '220.184.34.132:8002',
    ], '100.89.71.56')).toEqual([
      '100.79.13.15:8002',
      '220.184.34.132:8002',
    ])
  })

  it('recognizes private IPv4-with-port and bracketed IPv6 forms', () => {
    expect(isPrivateBrowserHost('100.64.0.1:8080')).toBe(true)
    expect(isPrivateBrowserHost('100.127.255.254:8080')).toBe(true)
    expect(isPrivateBrowserHost('100.128.0.1:8080')).toBe(false)
    expect(isPrivateBrowserHost('[fd00::1]:8080')).toBe(true)
    expect(isPrivateBrowserHost('[2001:4860:4860::8888]:8080')).toBe(false)
  })
})
