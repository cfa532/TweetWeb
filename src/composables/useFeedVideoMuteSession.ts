import { ref } from 'vue'

const FEED_VIDEO_MUTED_SESSION_KEY = 'feedVideoMuted'

function readInitialFeedVideoMutedState(): boolean {
  if (typeof sessionStorage === 'undefined') return true

  try {
    const persisted = sessionStorage.getItem(FEED_VIDEO_MUTED_SESSION_KEY)
    if (persisted === null) return true
    return persisted === '1'
  } catch {
    return true
  }
}

const isFeedVideoMuted = ref(readInitialFeedVideoMutedState())

function persistFeedVideoMutedState(value: boolean) {
  if (typeof sessionStorage === 'undefined') return

  try {
    sessionStorage.setItem(FEED_VIDEO_MUTED_SESSION_KEY, value ? '1' : '0')
  } catch {}
}

export function setFeedVideoMuted(value: boolean) {
  isFeedVideoMuted.value = value
  persistFeedVideoMutedState(value)
}

export function applyFeedVideoMutedState(video: HTMLVideoElement) {
  video.muted = isFeedVideoMuted.value
  if (!video.muted && video.volume === 0) {
    video.volume = 1
  }
}

export function useFeedVideoMuteSession() {
  return {
    isFeedVideoMuted,
    setFeedVideoMuted,
    applyFeedVideoMutedState,
  }
}
