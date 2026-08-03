function hostFromAddress(address: string): string {
  const raw = String(address ?? '').trim()
  if (!raw) return ''

  try {
    if (raw.includes('://')) {
      return new URL(raw).hostname.replace(/^\[|\]$/g, '').toLowerCase()
    }
  } catch {
    return ''
  }

  if (raw.startsWith('[')) {
    const closingBracket = raw.indexOf(']')
    if (closingBracket <= 1) return ''
    const suffix = raw.slice(closingBracket + 1)
    if (suffix && !/^:\d+$/.test(suffix)) return ''
    return raw.slice(1, closingBracket).toLowerCase()
  }

  const ipv4 = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?$/)
  if (ipv4) return ipv4Octets(ipv4[1]) ? ipv4[1] : ''

  if (raw.includes(':')) {
    const hostPort = raw.match(/^([a-z0-9.-]+):\d+$/i)
    if (hostPort) return hostPort[1].toLowerCase()
    if (/^[0-9a-f:]+(?:%[a-z0-9_.-]+)?$/i.test(raw)) return raw.toLowerCase()
    return ''
  }

  return /^[a-z0-9.-]+$/i.test(raw) ? raw.toLowerCase() : ''
}

function ipv4Octets(host: string): number[] | undefined {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return undefined
  const octets = host.split('.').map(Number)
  return octets.every(octet => octet >= 0 && octet <= 255) ? octets : undefined
}

/** Public dTweet entry and browser-fallback hosts. */
export function isPublicWebGatewayHost(address: string): boolean {
  const host = hostFromAddress(address)
  return host === 'dtweet.com' ||
    host === 'www.dtweet.com' ||
    host === 'dl.dtweet.com' ||
    host === 't1.www333.store'
}

/** Whether a browser treats this host as local/private rather than public. */
export function isPrivateBrowserHost(address: string): boolean {
  const host = hostFromAddress(address)
  if (!host) return false

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.ts.net')) {
    return true
  }

  const octets = ipv4Octets(host)
  if (octets) {
    const [a, b] = octets
    return a === 127 ||
      a === 10 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
  }

  const ipv6 = host.split('%')[0]
  return ipv6 === '::1' || /^fe[89ab]/i.test(ipv6) || /^f[cd]/i.test(ipv6)
}

/**
 * Removes routes Chrome will block through Private Network Access.
 * Private/tailnet pages retain private routes because both sides are in the
 * same browser address space.
 */
export function browserUsableProviderRoutes(addresses: string[], originHostname: string): string[] {
  const publicGateway = isPublicWebGatewayHost(originHostname)
  const seen = new Set<string>()

  return addresses
    .map(address => String(address ?? '').trim())
    .filter(address => hostFromAddress(address) !== '')
    // dTweet domains are web entry/gateway hosts, never provider nodes. Reject
    // them regardless of the current origin so stale routes cannot be restored
    // when the app is embedded or opened through a legacy Leither hostname.
    .filter(address => !isPublicWebGatewayHost(address))
    .filter(address => !publicGateway || !isPrivateBrowserHost(address))
    .filter(address => {
      if (seen.has(address)) return false
      seen.add(address)
      return true
    })
}
