/**
 * VideoPlaybackCoordinator – manages video playback in the tweet list.
 *
 *  - Tracks all registered video instances and their visibility (≥50% of the
 *    wrapper in view = visible; less = not eligible to play / primary is paused).
 *  - Picks the video closest to the scroll edge (topmost when scrolling
 *    down, bottommost when scrolling up) as the "primary".
 *  - Only one video plays at a time.
 *  - When the primary ends, the next sibling in the same tweet plays,
 *    then advances to the next visible video in the feed.
 *  - Debounces selection during scroll to avoid rapid switching.
 */

/** Callback invoked when a video's primary status changes. */
export type PrimaryChangeCallback = (isPrimary: boolean) => void

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
let primaryVideo: HTMLVideoElement | null = null
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/** At least this fraction of the video wrapper must be in the viewport to count as visible (play / stay primary). */
const MIN_VISIBLE_RATIO = 0.5
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
  }, { passive: true })
}

/** Register a video with the coordinator. Call from onMounted. */
export function registerVideo(el: HTMLVideoElement, wrapper: HTMLElement, onPrimaryChange?: PrimaryChangeCallback) {
  registry.set(el, { el, wrapper, ratio: 0, top: Infinity, onPrimaryChange })
  setupObserver(el, wrapper)
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
    if (primaryVideo === el) {
      el.removeEventListener('ended', handlePrimaryEnded)
      primaryVideo = null
      scheduleSelection()
    }
  }
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
      // Pause as soon as the primary drops below half visible; clear primary so a
      // quick scroll back re-runs full setPrimary and autoplay resumes correctly.
      if (el === primaryVideo) {
        const reg = registry.get(el)
        if (reg && reg.ratio < MIN_VISIBLE_RATIO && !el.ended) {
          if (!el.paused) el.pause()
          primaryVideo.removeEventListener('ended', handlePrimaryEnded)
          primaryVideo = null
          reg.onPrimaryChange?.(false)
        }
      }
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

/** Earlier in DOM / reading order wins when geometry is ambiguous (subpixel ties). */
function isBeforeInDocumentOrder(a: VideoEntry, b: VideoEntry): boolean {
  const pos = a.wrapper.compareDocumentPosition(b.wrapper)
  return Boolean(pos & Node.DOCUMENT_POSITION_FOLLOWING)
}

function selectPrimary() {
  let best: VideoEntry | null = null
  for (const entry of registry.values()) {
    if (entry.ratio < MIN_VISIBLE_RATIO || entry.el.ended) {
      continue
    }
    if (!best) {
      best = entry
      continue
    }
    const preferEntry =
      scrollDirection === 'down'
        ? entry.top < best.top - 1e-3 ||
          (Math.abs(entry.top - best.top) <= 1e-3 && isBeforeInDocumentOrder(entry, best))
        : entry.top > best.top + 1e-3 ||
          (Math.abs(entry.top - best.top) <= 1e-3 && isBeforeInDocumentOrder(best, entry))
    if (preferEntry) {
      best = entry
    }
  }

  if (best) {
    setPrimary(best.el)
  } else if (primaryVideo) {
    // No video is at least half visible – pause all and clear primary.
    primaryVideo.removeEventListener('ended', handlePrimaryEnded)
    for (const entry of registry.values()) {
      if (!entry.el.paused) {
        entry.el.pause()
      }
      entry.onPrimaryChange?.(false)
    }
    primaryVideo = null
  }
}

/** Try to autoplay a video element (muted for browser autoplay policy) */
function autoplayElement(el: HTMLVideoElement) {
  if (!el.paused) return
  if (el.ended) return
  el.muted = true
  el.volume = 0
  if (el.readyState >= 1) {
    el.play().catch(() => {})
  } else {
    el.addEventListener(
      'loadedmetadata',
      () => {
        if (primaryVideo === el) {
          el.play().catch(() => {})
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

  // Only advance if the tweet is still visible
  const tweetStillVisible = [...registry.values()].some(
    e => getTweetContainer(e) === tweetContainer && e.ratio >= MIN_VISIBLE_RATIO
  )
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
    // selectPrimary skips ended videos, so it will find the next candidate.
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
