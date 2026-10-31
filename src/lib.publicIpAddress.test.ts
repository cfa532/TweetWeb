import { describe, expect, it } from 'vitest'
import { publicIpAddressBaseUrl } from './lib'

describe('public node IP classification', () => {
    it.each([
        '1.1.1.1:8080',
        '[2606:4700:4700::1111]:8080',
        '[240e:391:edd:26d0::1]:8002',
        '[2001::1234]:8080',
    ])('retains public IP %s', address => {
        expect(publicIpAddressBaseUrl(address)).toBeDefined()
    })

    it.each([
        'localhost:8080', 'node.example.com:8080', '999.1.1.1:8080',
        '0.0.0.0:8080', '10.0.0.1:8080', '127.0.0.1:8080',
        '169.254.1.1:8080', '172.16.1.1:8080', '192.168.1.1:8080',
        '100.64.0.1:8080', '100.127.255.254:8080', '26.26.26.1:8080',
        '198.18.0.1:8080', '198.19.255.254:8080',
        '192.0.2.1:8080', '198.51.100.1:8080', '203.0.113.1:8080',
        '224.0.0.1:8080', '255.255.255.255:8080',
        '[::]:8080', '[::1]:8080', '[fd00::1]:8080', '[fe80::1]:8080', '[ff02::1]:8080',
        '[::ffff:192.168.1.1]:8080', '[::ffff:c0a8:101]:8080',
        '[2001:db8::1]:8080', '[3fff::1]:8080', '[2001:2::1]:8080',
        '[2001::ffff:ffff:ffff:fff0]:8080',
        '[2001:0000:0000:0000:ffff:ffff:ffff:fff3]:8080',
    ])('rejects non-public or VPN IP %s', address => {
        expect(publicIpAddressBaseUrl(address)).toBeUndefined()
    })
})
