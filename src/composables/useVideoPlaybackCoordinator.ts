/**
 * VideoPlaybackCoordinator – manages video playback in the tweet list.
 *
 *  - Tracks all registered video instances and their visibility.
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

const VISIBILITY_THRESHOLD = 0.5
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

function selectPrimary() {
  let best: VideoEntry | null = null
  for (const entry of registry.values()) {
    if (entry.ratio >= VISIBILITY_THRESHOLD && !entry.el.ended) {
      if (!best) {
        best = entry
      } else if (scrollDirection === 'down' ? entry.top < best.top : entry.top > best.top) {
        best = entry
      }
    }
  }

  if (best) {
    setPrimary(best.el)
  } else if (primaryVideo) {
    // No video above the selection threshold. Apply hysteresis: keep the
    // current primary as long as its tweet is still partially on-screen.
    // This prevents stop/restart flicker when ratios briefly dip during scroll.
    const primaryEntry = registry.get(primaryVideo)
    const tweetContainer = primaryEntry ? getTweetContainer(primaryEntry) : null
    const tweetStillVisible = tweetContainer
      ? [...registry.values()].some(
          e => getTweetContainer(e) === tweetContainer && e.ratio > 0
        )
      : primaryEntry && primaryEntry.ratio > 0

    if (tweetStillVisible) return

    // Tweet is fully off-screen – pause all active videos
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
    e => getTweetContainer(e) === tweetContainer && e.ratio > 0
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
