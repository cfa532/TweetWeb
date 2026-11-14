// userSession.ts — the caller's Leither session, the web counterpart of iOS
// OwnerSession.swift.
//
// A node that checks "usersid" (advertised in health as userSessions) expects
// the caller to sign in to the node's own Leither login — a guest with the
// username and password Leither holds for them — and to pass the session it
// receives on every write to the caller's own data. A session is valid only on
// the node that issued it and lives about an hour, so one is kept per account
// per node and re-opened when the node drops it ("Session invalid").

/** A Leither session lives an hour; treat one as stale well before that. */
const SESSION_FRESH_MS = 45 * 60 * 1000

interface LeitherLoginReply {
    Sid: string
    Uid: string
}

const sessions = new Map<string, { sid: string, at: number }>()

export function cachedSession(accountId: string, ip: string): string | null {
    const cached = sessions.get(`${accountId}@${ip}`)
    if (cached && Date.now() - cached.at < SESSION_FRESH_MS) return cached.sid
    return null
}

export function rememberSession(accountId: string, ip: string, sid: string) {
    sessions.set(`${accountId}@${ip}`, { sid, at: Date.now() })
}

export function discardSession(accountId: string, ip: string) {
    sessions.delete(`${accountId}@${ip}`)
}

// The guest credential of the signed-in account, kept in sessionStorage: it
// exists to re-open a session for later writes in this tab, and disappears
// with it. iOS keeps the same material in the Keychain; a longer-lived web
// store would need the same care and is deliberately out of scope here.
const credentialKey = (mid: string) => `tweetweb.credentials.${mid}`

export function storeCredential(mid: string, username: string, password: string) {
    try {
        sessionStorage.setItem(credentialKey(mid), JSON.stringify({ username, password }))
    } catch (error) {
        console.warn('[userSession] credential not stored', error)
    }
}

export function loadCredential(mid: string): { username: string, password: string } | null {
    try {
        const raw = sessionStorage.getItem(credentialKey(mid))
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (parsed?.username && parsed?.password) return parsed
    } catch {
        // fall through
    }
    return null
}

export function clearCredential(mid: string) {
    try {
        sessionStorage.removeItem(credentialKey(mid))
    } catch {
        // fall through
    }
}

/** True when a reply says the node no longer knows the session it was given. */
export function isSessionInvalid(reply: any): boolean {
    if (!reply || typeof reply !== 'object') return false
    return (reply.message ?? reply.error) === 'Session invalid'
}

/** Sign in to the node this client points at; null when it refused. */
export async function leitherLogin(client: any, username: string, password: string): Promise<LeitherLoginReply | null> {
    try {
        const reply = await client.Login(username, password)
        const sid = reply?.Sid ?? reply?.sid
        const uid = reply?.Uid ?? reply?.uid
        if (sid && uid) return { Sid: sid, Uid: uid }
        console.warn('[userSession] Login returned no session', reply)
        return null
    } catch (error) {
        console.warn('[userSession] Login failed', error)
        return null
    }
}

/** Register a guest with Leither on the node this client points at; its uid, or null. */
export async function leitherRegister(client: any, username: string, password: string): Promise<string | null> {
    try {
        const uid = await client.Register(username, password, '')
        if (uid) return uid
        console.warn('[userSession] Register returned no uid')
        return null
    } catch (error) {
        console.warn('[userSession] Register failed', error)
        return null
    }
}
