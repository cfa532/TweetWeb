import { describe, expect, it } from 'vitest'
import { isBrowserReload, shouldResyncUser } from './lib'

function performanceWithNavigationType(type?: NavigationTimingType, name = 'https://example.test/tweet/1') {
    return {
        getEntriesByType: () => type === undefined ? [] : [{ type, name } as PerformanceNavigationTiming],
    }
}

describe('isBrowserReload', () => {
    it('returns true only for a reload navigation entry', () => {
        expect(isBrowserReload(performanceWithNavigationType('reload'), 'https://example.test/tweet/1')).toBe(true)
        expect(isBrowserReload(performanceWithNavigationType('navigate'), 'https://example.test/tweet/1')).toBe(false)
        expect(isBrowserReload(performanceWithNavigationType('back_forward'), 'https://example.test/tweet/1')).toBe(false)
    })

    it('does not treat a later SPA route as the reloaded document', () => {
        const performanceApi = performanceWithNavigationType('reload', 'https://example.test/')
        expect(isBrowserReload(performanceApi, 'https://example.test/tweet/1')).toBe(false)
    })

    it('defaults to ordinary navigation when timing data is unavailable', () => {
        expect(isBrowserReload(performanceWithNavigationType())).toBe(false)
        expect(isBrowserReload(undefined)).toBe(false)
    })
})

describe('shouldResyncUser', () => {
    it('resyncs only when the read node differs from the root node', () => {
        expect(shouldResyncUser({ hostIds: ['root', 'read'] })).toBe(true)
        expect(shouldResyncUser({ hostIds: ['root', 'root'] })).toBe(false)
        expect(shouldResyncUser({ hostIds: ['root'] })).toBe(false)
        expect(shouldResyncUser({ hostIds: [] })).toBe(false)
        expect(shouldResyncUser(undefined)).toBe(false)
    })
})
