/**
 * VideoPlaybackCoordinator – manages video playback in the tweet list.
 *
 *  - Tracks all registered video instances and their visibility.
 *  - Picks the topmost sufficiently-visible video as the "primary".
 *  - All videos within the same tweet as the primary also autoplay.
 *  - Videos in other tweets are paused.
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

function selectPrimary() {
  // Find topmost video that is at least 50% visible
  let best: VideoEntry | null = null
  for (const entry of registry.values()) {
    if (entry.ratio >= VISIBILITY_THRESHOLD) {
      if (!best || entry.top < best.top) {
        best = entry
      }
    }
  }

  if (best) {
    setPrimary(best.el)
  } else {
    // No video sufficiently visible – pause all active videos (primary + siblings)
    for (const entry of registry.values()) {
      if (!entry.el.paused) {
        entry.el.pause()
      }
      entry.onPrimaryChange?.(false)
    }
    primaryVideo = null
  }
}

/** Find the .tweet-container ancestor for a registry entry */
function getTweetContainer(entry: VideoEntry): HTMLElement | null {
  return entry.wrapper?.closest('.tweet-container') as HTMLElement | null
}

/** Try to autoplay a video element (muted for browser autoplay policy) */
function autoplayElement(el: HTMLVideoElement) {
  if (!el.paused) return
  el.muted = true
  el.volume = 0
  if (el.readyState >= 1) {
    el.play().catch(() => {})
  } else {
    // Wait for the video to be ready, then play. The actual loading is
    // triggered by the onPrimaryChange callback (setupHLS / startLoad),
    // so we must NOT call el.load() here — a second load() aborts the
    // in-progress resource selection and can cause a visible "refresh".
    el.addEventListener(
      'loadedmetadata',
      () => {
        if (primaryVideo === el || isSiblingOfPrimary(el)) {
          el.play().catch(() => {})
        }
      },
      { once: true }
    )
  }
}

/** Check if el is a sibling of the current primary video (same tweet) */
function isSiblingOfPrimary(el: HTMLVideoElement): boolean {
  if (!primaryVideo) return false
  const primaryEntry = registry.get(primaryVideo)
  const elEntry = registry.get(el)
  if (!primaryEntry || !elEntry) return false
  const container = getTweetContainer(primaryEntry)
  return !!container && container === getTweetContainer(elEntry)
}

function setPrimary(el: HTMLVideoElement) {
  if (primaryVideo === el) return

  primaryVideo = el
  const newEntry = registry.get(el)
  const tweetContainer = newEntry ? getTweetContainer(newEntry) : null

  // Pause / deactivate videos NOT in the same tweet; activate siblings
  for (const entry of registry.values()) {
    if (entry.el === el) continue

    const isSibling = tweetContainer && getTweetContainer(entry) === tweetContainer
    if (isSibling) {
      entry.onPrimaryChange?.(true)
      autoplayElement(entry.el)
    } else {
      if (!entry.el.paused) {
        entry.el.pause()
      }
      entry.onPrimaryChange?.(false)
    }
  }

  // Notify and start the primary itself
  newEntry?.onPrimaryChange?.(true)
  autoplayElement(el)
}
