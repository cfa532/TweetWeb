import { describe, expect, it } from 'vitest'
import { browserUsableProviderRoutes, isPrivateBrowserHost, isPublicWebGatewayHost } from './browserNetwork'

describe('browser provider route eligibility', () => {
  it('keeps later public routes and rejects private routes from a public origin', () => {
    expect(browserUsableProviderRoutes([
      'dl.dtweet.com',
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

  it('retains node routes for legacy public Leither hosts', () => {
    expect(browserUsableProviderRoutes([
      '100.79.13.15:8002',
      '220.184.34.132:8002',
    ], 't1.fireshare.us')).toEqual([
      '100.79.13.15:8002',
      '220.184.34.132:8002',
    ])
  })

  it('never treats a dTweet web gateway as a provider node', () => {
    expect(browserUsableProviderRoutes([
      'dl.dtweet.com',
      '220.184.34.132:8002',
    ], 't1.fireshare.us')).toEqual(['220.184.34.132:8002'])
  })

  it('limits gateway mode to dTweet web hosts', () => {
    expect(isPublicWebGatewayHost('dtweet.com')).toBe(true)
    expect(isPublicWebGatewayHost('dl.dtweet.com')).toBe(true)
    expect(isPublicWebGatewayHost('t1.fireshare.us')).toBe(false)
    expect(isPublicWebGatewayHost('t1.www333.store')).toBe(false)
  })

  it('recognizes private IPv4-with-port and bracketed IPv6 forms', () => {
    expect(isPrivateBrowserHost('100.64.0.1:8080')).toBe(true)
    expect(isPrivateBrowserHost('100.127.255.254:8080')).toBe(true)
    expect(isPrivateBrowserHost('100.128.0.1:8080')).toBe(false)
    expect(isPrivateBrowserHost('[fd00::1]:8080')).toBe(true)
    expect(isPrivateBrowserHost('[2001:4860:4860::8888]:8080')).toBe(false)
  })
})
