import { ref, onActivated, onDeactivated, onUnmounted, nextTick } from 'vue'
import { onBeforeRouteLeave } from 'vue-router'

interface ScrollRestoreOptions {
    /** Whether more content can still be loaded (used to page in content on a deep reload). */
    hasMore: () => boolean
    /** Load one more page of content; no-op when already loading or exhausted. */
    loadMore: () => Promise<void>
    /** Saved offsets (px) at or below this are restored without pre-hiding the feed. */
    minRestoreOffset?: number
    /** Safety cap on how many pages restoreAfterLoad will pull in. */
    maxRestorePages?: number
}

/**
 * Persist window scroll for a keep-alive list page to sessionStorage and restore
 * it without the top-then-position flash.
 *
 * - Back-navigation: the kept-alive DOM is already at full height, so `onActivated`
 *   restores synchronously before the browser paints — no flash.
 * - Reload / fresh load: content is paginated, so we load more pages until the
 *   document is tall enough, then jump. The feed is pre-hidden (via `restoring`)
 *   so the top of the list never flashes while content catches up.
 *
 * Pair with `scrollBehavior` returning `false` for the route so vue-router does
 * not apply a delayed scroll that reintroduces the flash.
 */
export function useScrollRestore(storageKey: string | (() => string), opts: ScrollRestoreOptions) {
    const resolveKey = () =>
        `scrollPos:${typeof storageKey === 'function' ? storageKey() : storageKey}`
    const minOffset = opts.minRestoreOffset ?? 400
    const maxPages = opts.maxRestorePages ?? 80

    const restoring = ref(false)
    let active = false
    let didInitialRestore = false
    let saveTimer: ReturnType<typeof setTimeout> | null = null

    function readSaved(): number {
        try {
            return parseInt(sessionStorage.getItem(resolveKey()) || '0', 10) || 0
        } catch {
            return 0
        }
    }

    function persist() {
        try {
            sessionStorage.setItem(resolveKey(), String(window.scrollY))
        } catch {
            /* sessionStorage unavailable — ignore */
        }
    }

    function saveDebounced() {
        if (saveTimer) clearTimeout(saveTimer)
        saveTimer = setTimeout(persist, 120)
    }

    function onScroll() {
        // Only capture while this page is the active route, and never while we are
        // mid-restore (those synthetic positions are not the user's real spot).
        if (!active || restoring.value) return
        saveDebounced()
    }

    // Pre-hide on a deep reload so the top of the feed never flashes before the
    // paginated content catches up. Evaluated once at setup(), before first paint.
    if (readSaved() > minOffset) restoring.value = true

    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', persist)

    /**
     * Jump to a scroll offset instantly. Bootstrap's Reboot sets
     * `scroll-behavior: smooth` on :root, which would otherwise animate our
     * restore (and the app only wants smooth scrolling where it passes
     * `behavior: 'smooth'` explicitly). We toggle the inline style for one call.
     */
    function scrollInstant(y: number) {
        const root = document.documentElement
        const prev = root.style.scrollBehavior
        root.style.scrollBehavior = 'auto'
        window.scrollTo(0, y)
        root.style.scrollBehavior = prev
    }

    /** Synchronous restore for keep-alive re-activation (DOM is already full height). */
    function restoreSync() {
        const y = readSaved()
        if (y > 0) scrollInstant(y)
    }

    /** Async restore for a fresh load / reload: page in content until tall enough, then jump. */
    async function restoreAfterLoad() {
        try {
            const targetY = readSaved()
            if (targetY <= 0) return
            await nextTick()
            const tallEnough = () =>
                document.documentElement.scrollHeight >= targetY + window.innerHeight
            if (!tallEnough()) {
                restoring.value = true
                let pages = 0
                while (!tallEnough() && opts.hasMore() && pages < maxPages) {
                    if (!active) return // user navigated away — don't scroll a different page
                    pages++
                    await opts.loadMore()
                    await nextTick()
                }
            }
            if (active) scrollInstant(targetY)
        } finally {
            restoring.value = false
            didInitialRestore = true
        }
    }

    onActivated(() => {
        active = true
        // Skip the very first activation: the page's onMounted/watch owns the
        // fresh-load path (content may still be loading). Every later activation
        // is a return from a sub-route, so restore synchronously.
        if (didInitialRestore) restoreSync()
        didInitialRestore = true
    })
    onDeactivated(() => {
        active = false
        // Deliberately do NOT persist here. onDeactivated runs *after* vue-router
        // has already scrolled for the outgoing navigation, so window.scrollY is 0
        // — persisting would overwrite the real saved position with 0.
    })
    // Authoritative save point: fires before vue-router resolves the navigation
    // (and before it scrolls for the next route), so window.scrollY is still the
    // user's real position on this page. Clear the pending debounce so it can't
    // overwrite this value with a later (post-scroll) sample.
    onBeforeRouteLeave(() => {
        persist()
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null }
    })
    onUnmounted(() => {
        window.removeEventListener('scroll', onScroll)
        window.removeEventListener('pagehide', persist)
        if (saveTimer) clearTimeout(saveTimer)
    })

    /** True when there is a saved scroll deep enough to warrant pre-hiding the feed. */
    function hasDeepSavedScroll() {
        return readSaved() > minOffset
    }

    return { restoring, restoreAfterLoad, hasDeepSavedScroll }
}
