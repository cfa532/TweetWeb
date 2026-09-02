import { ref } from 'vue'

/**
 * VideoPlaybackCoordinator – manages video playback in the tweet list.
 *
 *  - Tracks all registered video instances. Primary eligibility is measured on
 *    each video's TWEET container (stable card the user is reading), not the
 *    small video tile, with geometry read fresh so a fast scroll can't pick a
 *    stale primary.
 *  - Picks the video closest to the scroll edge (topmost when scrolling
 *    down, bottommost when scrolling up) as the "primary".
 *  - Only one video plays at a time.
 *  - When the primary ends, the next sibling in the same tweet plays,
 *    then advances to the next visible video in the feed.
 *  - Debounces selection during scroll to avoid rapid switching.
 *  - Exposes primary health so the media-loading coordinator can defer
 *    offscreen preloads until the primary is buffered enough to play.
 */

/** Callback invoked when a video's primary status changes. */
export type PrimaryChangeCallback = (isPrimary: boolean) => void

/**
 * Reactive bridge to the media-loading coordinator. Preloads (offscreen video
 * or image) wait until the primary is healthy — unless no primary exists, in
 * which case there is nothing to prioritize and preloads proceed.
 */
export const primaryVideoHealthy = ref(false)
export const hasPrimaryVideo = ref(false)

/** Update the global primary-health flag. Only the current primary may set it,
 *  so a stale/demoted VideoJS instance can't keep preloads blocked or unblock them. */
export function setPrimaryVideoHealthy(el: HTMLVideoElement, healthy: boolean) {
  if (primaryVideo !== el) return
  primaryVideoHealthy.value = healthy
}

interface VideoEntry {
  /** The <video> element */
  el: HTMLVideoElement
  /** The outer wrapper div used for IntersectionObserver measurements */
  wrapper: HTMLElement
  /** Last known intersection ratio (0-1) */
  ratio: number
  /** Last known boundingClientRect.top */
  top: number
  /** Optional callback when primary status changes */
  onPrimaryChange?: PrimaryChangeCallback
}

const registry = new Map<HTMLVideoElement, VideoEntry>()
// Videos that stopped because they dropped below the keep threshold. They won't
// be re-promoted while still in the [play, keep) band (50–70%), which is what
// makes "stop below 70%" hold instead of flapping; cleared once back ≥ 70%.
const yieldedVideos = new Set<HTMLVideoElement>()
// Videos that played to their end. The player rewinds a finished video to its
// first frame (so a tile doesn't sit on a black last frame), which clears the
// element's `ended` flag — this set, not `el.ended`, is what "already played"
// means here. Cleared when the video is unregistered or explicitly promoted.
const finishedVideos = new Set<HTMLVideoElement>()
let primaryVideo: HTMLVideoElement | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** A video starts playing once this fraction of its TWEET container is visible. */
const MIN_PLAY_VISIBLE_RATIO = 0.5
/** The current primary stops once its tweet container drops below this fraction. */
const MIN_KEEP_VISIBLE_RATIO = 0.7
const DEBOUNCE_MS = 200

// Track scroll direction so selectPrimary can pick the video the user is
// scrolling toward: topmost when scrolling down, bottommost when scrolling up.
let scrollDirection: 'down' | 'up' = 'down'
let lastScrollY = 0
if (typeof window !== 'undefined') {
  window.addEventListener('scroll', () => {
    const y = window.scrollY
    if (y !== lastScrollY) scrollDirection = y > lastScrollY ? 'down' : 'up'
    lastScrollY = y
    // Re-evaluate primary on scroll so the keep/demote thresholds (measured
    // fresh) actually take effect as the user scrolls, not only at IO thresholds.
    scheduleSelection()
  }, { passive: true })
}

/** Register a video with the coordinator. Call from onMounted. */
export function registerVideo(el: HTMLVideoElement, wrapper: HTMLElement, onPrimaryChange?: PrimaryChangeCallback) {
  registry.set(el, { el, wrapper, ratio: 0, top: Infinity, onPrimaryChange })
  setupObserver(el, wrapper)
  // Consider this video immediately — embedded/quote-tweet videos mount late
  // (after the quoted tweet resolves) and would otherwise wait for an
  // IntersectionObserver tick before they can be picked, so a fully-visible
  // one wouldn't autoplay right away.
  scheduleSelection()
}

/** Unregister a video. Call from onUnmounted. */
export function unregisterVideo(el: HTMLVideoElement) {
  const entry = registry.get(el)
  if (entry) {
    const obs = observers.get(el)
    if (obs) {
      obs.disconnect()
      observers.delete(el)
    }
    registry.delete(el)
    yieldedVideos.delete(el)
    finishedVideos.delete(el)
    if (primaryVideo === el) {
      el.removeEventListener('ended', handlePrimaryEnded)
      primaryVideo = null
      hasPrimaryVideo.value = false
      primaryVideoHealthy.value = false
      scheduleSelection()
    }
  }
}

/** Mark a video as played to its end, so it is no longer an autoplay candidate.
 *  Called by the player from its own 'ended' handler, which rewinds the element
 *  and therefore clears `el.ended` before the coordinator could read it. */
export function markVideoFinished(el: HTMLVideoElement) {
  if (registry.has(el)) finishedVideos.add(el)
}

/** Call when a user explicitly taps play on a specific video. */
export function requestPlay(el: HTMLVideoElement) {
  setPrimary(el)
}

/** True if this element is the single feed primary (avoids stale HLS/autoplay callbacks starting a demoted video). */
export function isCoordinatorPrimary(el: HTMLVideoElement): boolean {
  return primaryVideo === el
}

// --- internals ---

const observers = new Map<HTMLVideoElement, IntersectionObserver>()

function setupObserver(el: HTMLVideoElement, wrapper: HTMLElement) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const reg = registry.get(el)
        if (reg) {
          reg.ratio = entry.intersectionRatio
          reg.top = entry.boundingClientRect.top
        }
      }
      // Promote/demote decisions live in selectPrimary (which reads fresh tweet
      // geometry); the observer just keeps the wrapper cache current and kicks
      // a (debounced) re-evaluation.
      scheduleSelection()
    },
    { threshold: [0, 0.25, 0.5, 0.75, 1.0] }
  )
  observer.observe(wrapper)
  observers.set(el, observer)
}

function scheduleSelection() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(selectPrimary, DEBOUNCE_MS)
}

/** Find the .tweet-container ancestor for a registry entry */
function getTweetContainer(entry: VideoEntry): HTMLElement | null {
  return entry.wrapper?.closest('.tweet-container') as HTMLElement | null
}

/** Fresh viewport intersection ratio (0-1) for an element, straight from layout.
 *  Avoids relying on IntersectionObserver's threshold-stepped cache, which goes
 *  stale between crossings and made primary selection lag behind a fast scroll. */
function viewportRatioFor(element: HTMLElement | null): number {
  if (!element || typeof window === 'undefined') return 0
  const rect = element.getBoundingClientRect()
  if (rect.height <= 0) return 0
  const visibleTop = Math.max(rect.top, 0)
  const visibleBottom = Math.min(rect.bottom, window.innerHeight)
  const visibleHeight = Math.max(0, visibleBottom - visibleTop)
  return Math.max(0, visibleHeight / rect.height)
}

/** Live viewport ratio + top of a video's tweet container (null if no container). */
function tweetVisibility(entry: VideoEntry): { ratio: number; top: number } | null {
  const container = getTweetContainer(entry)
  if (!container) return null
  return { ratio: viewportRatioFor(container), top: container.getBoundingClientRect().top }
}

/** Earlier in DOM / reading order wins when geometry is ambiguous (subpixel ties). */
function isBeforeInDocumentOrder(a: VideoEntry, b: VideoEntry): boolean {
  const pos = a.wrapper.compareDocumentPosition(b.wrapper)
  return Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING)
}

function selectPrimary() {
  if (primaryVideo) {
    const current = registry.get(primaryVideo)
    if (current && !finishedVideos.has(current.el)) {
      const tweetRatio = tweetVisibility(current)?.ratio ?? 0
      if (tweetRatio >= MIN_KEEP_VISIBLE_RATIO) {
        return // still mostly visible — keep playing
      }
      // Dropped below the keep threshold: stop and yield to the next video.
      yieldedVideos.add(primaryVideo)
      if (!current.el.paused) current.el.pause()
      primaryVideo.removeEventListener('ended', handlePrimaryEnded)
      const cb = current.onPrimaryChange
      primaryVideo = null
      hasPrimaryVideo.value = false
      primaryVideoHealthy.value = false
      cb?.(false)
      // fall through and pick a new primary
    }
  }

  // Rank candidates by their TWEET container's live geometry, not the video
  // wrapper's. The tweet is the stable unit the user is actually reading.
  let best: VideoEntry | null = null
  let bestTweet: HTMLElement | null = null
  let bestTop = 0
  let bestRatio = 0
  for (const entry of registry.values()) {
    if (finishedVideos.has(entry.el)) continue
    // Hard guard: the video's own wrapper must still intersect the viewport,
    // otherwise a tall tweet that is in view but whose media grid scrolled past
    // could be promoted.
    if (entry.ratio <= 0) continue
    const info = tweetVisibility(entry)
    if (!info) continue
    // A yielded video stopped below the keep threshold; it must climb back to
    // ≥ keep before it is eligible again (prevents flapping in the 50–70% band).
    if (yieldedVideos.has(entry.el)) {
      if (info.ratio >= MIN_KEEP_VISIBLE_RATIO) yieldedVideos.delete(entry.el)
      else continue
    }
    if (info.ratio < MIN_PLAY_VISIBLE_RATIO) continue
    const tweet = getTweetContainer(entry)

    if (!best) {
      best = entry
      bestTweet = tweet
      bestTop = info.top
      bestRatio = info.ratio
      continue
    }

    // Same tweet: pick the earlier video in DOM order (stable for multi-video tweets).
    if (tweet && bestTweet && tweet === bestTweet) {
      if (isBeforeInDocumentOrder(entry, best)) best = entry
      continue
    }

    // Different tweet: pick by scroll-direction edge, tiebreak on greater visibility.
    const preferEntry =
      scrollDirection === 'down'
        ? info.top < bestTop - 1e-3 ||
          (Math.abs(info.top - bestTop) <= 1e-3 && info.ratio > bestRatio)
        : info.top > bestTop + 1e-3 ||
          (Math.abs(info.top - bestTop) <= 1e-3 && info.ratio > bestRatio)
    if (preferEntry) {
      best = entry
      bestTweet = tweet
      bestTop = info.top
      bestRatio = info.ratio
    }
  }

  if (best) {
    setPrimary(best.el)
  } else if (primaryVideo) {
    // No video's tweet is at least half visible – pause all and clear primary.
    primaryVideo.removeEventListener('ended', handlePrimaryEnded)
    for (const entry of registry.values()) {
      if (!entry.el.paused) {
        entry.el.pause()
      }
      entry.onPrimaryChange?.(false)
    }
    primaryVideo = null
    hasPrimaryVideo.value = false
    primaryVideoHealthy.value = false
  }
}

/** Try to autoplay a video element (muted for browser autoplay policy) */
function autoplayElement(el: HTMLVideoElement) {
  if (!el.paused) return
  if (el.ended) return
  if (el.readyState >= 1) {
    el.play().catch(() => {
      // Autoplay fallback for browsers that block unmuted autoplay.
      el.muted = true
      el.play().catch(() => {})
    })
  } else {
    el.addEventListener(
      'loadedmetadata',
      () => {
        if (primaryVideo === el) {
          el.play().catch(() => {
            el.muted = true
            el.play().catch(() => {})
          })
        }
      },
      { once: true }
    )
  }
}

/** When the primary video ends, play the next sibling in the same tweet. */
function handlePrimaryEnded() {
  if (!primaryVideo) return
  const currentEntry = registry.get(primaryVideo)
  if (!currentEntry) return
  const tweetContainer = getTweetContainer(currentEntry)
  if (!tweetContainer) return

  // Only advance if the tweet is still visible (measured on the tweet container)
  const tweetStillVisible = (tweetVisibility(currentEntry)?.ratio ?? 0) >= MIN_KEEP_VISIBLE_RATIO
  if (!tweetStillVisible) return

  // Gather all videos in this tweet, sorted by DOM order
  const tweetVideos = [...registry.values()]
    .filter(e => getTweetContainer(e) === tweetContainer)
    .sort((a, b) => {
      const pos = a.wrapper.compareDocumentPosition(b.wrapper)
      return pos & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
    })

  const currentIndex = tweetVideos.findIndex(e => e.el === primaryVideo)
  if (currentIndex >= 0 && currentIndex + 1 < tweetVideos.length) {
    setPrimary(tweetVideos[currentIndex + 1].el)
  } else {
    // No more videos in this tweet — pick the next visible video in the feed.
    // selectPrimary skips finished videos, so it will find the next candidate.
    selectPrimary()
  }
}

function setPrimary(el: HTMLVideoElement) {
  if (primaryVideo === el) return

  // Clean up ended listener on old primary
  if (primaryVideo) {
    primaryVideo.removeEventListener('ended', handlePrimaryEnded)
  }

  primaryVideo = el
  yieldedVideos.delete(el)
  // Promotion is either a fresh candidate or an explicit user tap on a video
  // that already played — either way it is allowed to play again.
  finishedVideos.delete(el)
  hasPrimaryVideo.value = true
  // A newly promoted primary must earn healthy status before preloads resume.
  primaryVideoHealthy.value = false

  // Pause and deactivate every other video
  for (const entry of registry.values()) {
    if (entry.el !== el) {
      if (!entry.el.paused) {
        entry.el.pause()
      }
      entry.onPrimaryChange?.(false)
    }
  }

  // Notify and start the new primary
  const newEntry = registry.get(el)
  newEntry?.onPrimaryChange?.(true)
  autoplayElement(el)

  // When this video ends, advance to the next sibling in the same tweet
  el.addEventListener('ended', handlePrimaryEnded, { once: true })
}
