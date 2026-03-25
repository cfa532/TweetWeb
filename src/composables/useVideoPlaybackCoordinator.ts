/**
 * VideoPlaybackCoordinator - ensures only one video plays at a time in the tweet list.
 *
 * Inspired by the iOS VideoPlaybackCoordinator pattern:
 *  - Tracks all registered video instances and their visibility.
 *  - Picks the topmost sufficiently-visible video as the "primary".
 *  - Pauses every other video when the primary changes.
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
    // No video sufficiently visible – pause current primary and stop all loading
    if (primaryVideo) {
      if (!primaryVideo.paused) {
        primaryVideo.pause()
      }
      const entry = registry.get(primaryVideo)
      entry?.onPrimaryChange?.(false)
    }
    primaryVideo = null
  }
}

function setPrimary(el: HTMLVideoElement) {
  if (primaryVideo === el) return

  // Pause old primary and every other playing video; notify them they lost primary
  for (const entry of registry.values()) {
    if (entry.el !== el) {
      if (!entry.el.paused) {
        entry.el.pause()
      }
      entry.onPrimaryChange?.(false)
    }
  }

  primaryVideo = el

  // Notify the new primary
  const newEntry = registry.get(el)
  newEntry?.onPrimaryChange?.(true)

  // Start the new primary (muted for autoplay compatibility)
  if (el.paused) {
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
      el.load()
    }
  }
}
