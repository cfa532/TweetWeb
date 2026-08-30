<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick, inject } from 'vue';
import type { PropType } from 'vue'
import Hls from 'hls.js';
import { useRouter } from 'vue-router';
import { useTweetStore } from '@/stores';
import { registerVideo, unregisterVideo, requestPlay, isCoordinatorPrimary, setPrimaryVideoHealthy, type PrimaryChangeCallback } from '@/composables/useVideoPlaybackCoordinator';
import { TWEET_MEDIA_PRELOAD_STALE_EVENT, type MediaLoadState } from '@/composables/useTweetMediaLoadingCoordinator';
import { useFeedVideoMuteSession } from '@/composables/useFeedVideoMuteSession';

// Cross-instance HLS playlist cache, keyed by base media URL. The same
// stream may be opened by multiple VideoJS instances (e.g. once in the
// feed and once in the tweet detail view) on different copies of the
// media object — the per-prop cache (props.media.playlist) doesn't survive
// the JSON.parse round trip from sessionStorage. Caching globally lets the
// detail view skip playlist selection when the feed already resolved the same
// stream. On a cache miss, HLS setup probes both playlist filenames at the
// same time and caches the first valid one.
type HLSPlaylistFilename = 'master.m3u8' | 'playlist.m3u8';
type HLSPlaylistSourceName = 'master' | 'playlist';
type HLSPlaylistCandidate = {
  fileName: HLSPlaylistFilename;
  sourceName: HLSPlaylistSourceName;
  url: string;
};
const TWEET_DETAIL_MEDIA_READY_EVENT = 'tweet-detail-media-ready';
const globalPlaylistFilenameCache = new Map<string, HLSPlaylistFilename>();

const props = defineProps({
  media: { type: Object as PropType<MimeiFileType>, required: true },
  autoplay: { type: Boolean, required: false },
  tweet: { type: Object as PropType<Tweet>, required: false },
  mediaList: { type: Array as PropType<MimeiFileType[]>, required: false },
  mediaIndex: { type: Number, required: false },
  mediaLoadState: { type: String as PropType<MediaLoadState>, required: false, default: 'visible' },
})
const router = useRouter();
const tweetStore = useTweetStore();
const vdiv = ref();
const video = ref();
const coverCanvas = ref<HTMLCanvasElement | null>(null);
const hasCoverFrame = ref(false);
const isPlaying = ref(false);
const isPortrait = ref(false);
const autoplayBlocked = ref(false);
const showPlayOverlay = ref(!props.autoplay); // Don't show overlay initially if autoplay is enabled
const isAudio = props.media.type?.toLowerCase().includes('audio') ?? false;
// Feed: defer attaching <source> for regular MP4s until the coordinator marks
// this video the primary. Without this gate every MP4 in the feed begins
// buffering on render even with preload=none on some browsers, hammering the
// connection pool. Detail view always loads.
const regularVideoActive = ref(false);
// In list/feed (typically non-autoplay), avoid showing spinner before user action.
const isBuffering = ref(!isAudio && !!props.autoplay);
// True while the coordinator has marked this video as primary and auto-play
// hasn't started yet. Prevents the play overlay from flashing and keeps the
// spinner visible between MANIFEST_PARSED and actual playback.
const coordinatorAutoplayPending = ref(false);
const showVideoError = ref(false); // Show error message when video fails to play
const isFullscreenActive = ref(false);
const isMobile = isMobileBrowser(); // cached at setup time

// Touch handling for mobile scroll detection
const touchStartX = ref(0);
const touchStartY = ref(0);
const touchStartTime = ref(0);
const isScrolling = ref(false);
  const isHLS = computed(() => {
    const mediaType = props.media.type?.toLowerCase();
    return mediaType === 'hls_video';
  });

  const isRegularVideo = computed(() => {
    const mediaType = props.media.type?.toLowerCase();
    return mediaType === 'video';
  });

  // Render <source> for regular MP4 when it is visible/preloading so a
  // non-primary visible video can keep showing its frame instead of flashing black.
  const shouldRenderRegularSource = computed(() => {
    if (!isRegularVideo.value) return false;
    if (!isInTweetList.value) return true;
    return regularVideoActive.value || props.mediaLoadState !== 'idle';
  });

  // Visible/preloaded feed videos may keep their frame buffered, but playback is still owned by the primary coordinator.
  const videoPreload = computed(() => {
    if (!isInTweetList.value) return 'auto';
    return regularVideoActive.value || props.mediaLoadState !== 'idle' ? 'auto' : 'none';
  });
// Tracks whether the video has reported its metadata yet. Used to suppress
// native browser controls during the initial load so the native loading
// spinner (a hard-to-see dark gray on Safari) doesn't compete with our
// white buffering overlay.
const hasMetadata = ref(false);

// Show native controls on desktop detail view after metadata loads, but hide
// them while our own loading indicator is active so the browser spinner does
// not appear alongside it.
// Native controls: always in fullscreen (browser handles tap-to-show), otherwise
// only on desktop detail view once metadata is ready.
const showControls = computed(() =>
  isFullscreenActive.value ||
  (!isMobileBrowser() && !isInTweetList.value && hasMetadata.value && !showBufferingOverlay.value)
)

const canShowPausedOverlays = computed(() => {
  return !isFullscreenActive.value && // Native controls handle play in fullscreen
    !showVideoError.value &&
    !(autoplayBlocked.value && props.autoplay) &&
    !isPlaying.value &&
    !coordinatorAutoplayPending.value &&
    // On mobile hide the play overlay while the loading spinner is up so
    // the two never stack on top of each other.
    (!isBuffering.value || (isMobile && !showBufferingOverlay.value));
});

const controls = computed(()=>{
  return props.media.downloadable==false ? "nodownload" : undefined
})

// TweetDetail provides this so embedded quote-tweet videos don't get
// gated by the feed playback coordinator (which can leave them stuck on
// the spinner if the embedded box never reaches the 50%-visible threshold).
const isInTweetDetailPage = inject<boolean>('isInTweetDetailPage', false);

// Detect if this video is being displayed in a tweet list context
const isInTweetList = computed(() => {
  // The detail page renders quoted tweets via TweetView, which adds the
  // .tweet-container ancestor. Without this guard those embedded videos
  // would defer to the coordinator and never start loading.
  if (isInTweetDetailPage) return false;
  // Check if we're in a tweet list by looking for tweet list specific elements
  const tweetContainer = vdiv.value?.closest('.tweet-container');
  const isInList = tweetContainer && !tweetContainer.closest('.card-body')?.closest('.comment');
  return isInList;
});

// Pre-size wrapper in detail/modal; in feed, .media-attachments already sets aspect-ratio — a second
// ratio here letterboxes (black band) under the video.
// Detail view: prefer the live ratio from loadedmetadata once the video
// reports its real dimensions, then media.aspectRatio (server hint), then
// 16/9 fallback so the loading skeleton still fills the container.
const measuredAspectRatio = ref<number | null>(null);
const videoWrapperStyle = computed(() => {
  if (isInTweetList.value) return {};
  const ar = measuredAspectRatio.value ?? props.media.aspectRatio;
  if (ar && ar > 0) return { aspectRatio: String(ar) };
  return { aspectRatio: '16 / 9' };
});

const timeRemainingText = ref('0:00');
const VIDEO_MUTED_STORAGE_KEY = 'feedVideoMuted';
const {
  isFeedVideoMuted,
  setFeedVideoMuted,
  applyFeedVideoMutedState,
} = useFeedVideoMuteSession();
const isMuted = ref(true);

const isSoleMediaInGrid = computed(() => {
  if (!props.mediaList || props.mediaList.length === 0) return true;
  return props.mediaList.length === 1;
});

const showFeedTimeRemaining = computed(
  () =>
    !isMobile &&
    isInTweetList.value &&
    !isFullscreenActive.value &&
    isSoleMediaInGrid.value &&
    !isAudio &&
    !showVideoError.value &&
    timeRemainingText.value !== '0:00',
);

const showFeedMuteButton = computed(
  () =>
    !isMobile &&
    isInTweetList.value &&
    !isFullscreenActive.value &&
    !isAudio &&
    !showVideoError.value,
);

const showFeedFullscreenButton = computed(
  () =>
    !isMobile &&
    showFeedMuteButton.value &&
    hasUserPausedInFeed.value &&
    !isPlaying.value,
);
const hasUserPausedInFeed = ref(false);
const hasCurrentFrame = computed(() => {
  const el = video.value;
  if (!el) return false;
  return el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
});
const hasLoadedMetadata = computed(() => {
  const el = video.value;
  return hasMetadata.value || (!!el && el.readyState >= HTMLMediaElement.HAVE_METADATA);
});

const showBufferingOverlay = computed(() => {
  // Feed: show spinner both while actively buffering and during initial fetch
  // before metadata arrives (prevents black tile on first load).
  if (isInTweetList.value) {
    const isActivelyStarting = isBuffering.value || coordinatorAutoplayPending.value;
    // Show during initial load before first frame arrives.
    if (props.mediaLoadState !== 'idle' && isActivelyStarting && !hasCurrentFrame.value && !showVideoError.value) return true;
    // Show during mid-play stalls signalled by the 'waiting' event.
    // Avoid reading non-reactive readyState here — hasPlayableFutureData cannot
    // trigger Vue updates on its own, which left the spinner stuck after buffer
    // recovered without any reactive dep changing.
    return isBuffering.value;
  }

  if (!isBuffering.value) return false;
  // Always show the spinner in detail/fullscreen view when buffering.
  // canShowPausedOverlays hides the play overlay while the spinner is up,
  // so the two never appear simultaneously.
  return true;
});

function syncVideoReadyState() {
  const el = video.value;
  if (!el) return;
  if (el.readyState >= HTMLMediaElement.HAVE_METADATA) {
    hasMetadata.value = true;
  }
  if (el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    hasRenderedVideoFrame = true;
    // Do NOT clear isBuffering here. HAVE_CURRENT_DATA means one frame is
    // available but the video would immediately stall — clearing the spinner
    // at this point creates a visible gap before 'waiting' fires again.
  }
  if (el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
    // HAVE_FUTURE_DATA only means that some data is buffered. It does not mean
    // playback has resumed after a `waiting`/`stalled` event, so leave the UI
    // buffering state to the `playing` and playback-progress handlers.
    // The coordinator can still use this as a bandwidth-health signal.
    reportPrimaryHealth(true);
  }
}

function markVideoBuffering() {
  isBuffering.value = true;
  consecutiveAdvanceTicks = 0;
}

function playFeedPrimaryVideo(videoElement: HTMLVideoElement) {
  if (!isInTweetList.value || !isCoordinatorPrimary(videoElement) || videoElement.ended) return;
  markMediaLoadRequested();
  requestPlay(videoElement);
  videoElement.play().catch(() => {
    videoElement.muted = true;
    videoElement.play().catch(() => {
      isBuffering.value = false;
      coordinatorAutoplayPending.value = false;
      showPlayOverlay.value = true;
    });
  });
}

// Tell the loading coordinator whether the feed primary has enough forward data
// to play without stalling, so offscreen preloads can be deferred until it does.
// Only the current primary reports; the guard makes a demoted instance a no-op.
function reportPrimaryHealth(healthy: boolean) {
  const el = video.value;
  if (!el || !isInTweetList.value || !isCoordinatorPrimary(el)) return;
  setPrimaryVideoHealthy(el, healthy);
}

function syncMutedState() {
  if (!video.value) return;
  isMuted.value = video.value.muted;
  try {
    if (isInTweetList.value) {
      setFeedVideoMuted(isMuted.value);
    } else {
      localStorage.setItem(VIDEO_MUTED_STORAGE_KEY, isMuted.value ? '1' : '0');
    }
  } catch {}
}

function getInitialMutedState(): boolean {
  try {
    const persisted = localStorage.getItem(VIDEO_MUTED_STORAGE_KEY);
    if (persisted === null) return true; // Default to muted
    return persisted === '1';
  } catch {
    return true;
  }
}

function applyCurrentFeedMutedState() {
  if (!isInTweetList.value || !video.value) return;
  applyFeedVideoMutedState(video.value);
  isMuted.value = video.value.muted;
}

watch(isFeedVideoMuted, () => {
  applyCurrentFeedMutedState();
});

function updateTimeRemaining() {
  const el = video.value;
  if (!el) return;
  const d = el.duration;
  const t = el.currentTime;
  if (!Number.isFinite(d) || d <= 0) {
    timeRemainingText.value = '0:00';
    return;
  }
  const remaining = Math.max(0, d - t);
  const minutes = Math.floor(remaining / 60);
  const seconds = Math.floor(remaining % 60);
  timeRemainingText.value = `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function handleMuteOverlayClick(event: Event) {
  event.stopPropagation();
  event.preventDefault();
  if (!video.value) return;
  video.value.muted = !video.value.muted;
  if (!video.value.muted && video.value.volume === 0) {
    // Feed autoplay previously drove volume to 0 for policy compliance.
    // Restore audible output when the user explicitly unmutes.
    video.value.volume = 1;
  }
  syncMutedState();
}

function handleFullscreenOverlayClick(event: Event) {
  event.stopPropagation();
  event.preventDefault();
  if (isHLS.value && !isHLSInitialized) {
    pendingUserPlayRequest = true;
    isBuffering.value = true;
    showVideoError.value = false;
    setupHLS();
  }
  requestFullscreen();
}

// Hardware acceleration detection – cached once per page load.
// The previous computed created a WebGL context on every evaluation, quickly
// exhausting the browser's context limit when many VideoJS instances exist.
const supportsHardwareAcceleration = (() => {
  if (typeof navigator === 'undefined') return false;
  return 'mediaCapabilities' in navigator;
})();

let hls: Hls | null = null;
let hasTriedSinglePlaylist = false;
let videoErrorRetryCount = 0;
const MAX_VIDEO_ERROR_RETRIES = 2;
let isRetryingVideo = false;
let lastHandledError: { code: number; src: string; timestamp: number } | null = null;
const ERROR_HANDLING_COOLDOWN = 3000; // 3 seconds cooldown between handling same error
let isHLSInitialized = false; // Prevent multiple HLS initializations
let isUnmounting = false;
let mediaErrorRecoveryCount = 0;
const MAX_MEDIA_ERROR_RECOVERIES = 3;
let lastMediaErrorTime = 0;
const MEDIA_ERROR_COOLDOWN = 2000; // 2 seconds cooldown between media error recoveries
let currentPlaylistType: HLSPlaylistSourceName | null = null;
let hasTriedPlaylistFallback = false;
let failedFragments = new Set<string>(); // Track fragments that have failed to avoid infinite loops
let pendingUserPlayRequest = false;
let hlsSetupToken = 0;
let mediaLoadEpoch = 0;
let lastStalePreloadCancelEpoch = -1;
let hasRenderedVideoFrame = false;
let keepCoverUntilNextFragment = false;
let hlsPlaylistProbeAbortController: AbortController | null = null;
// Last currentTime seen on a timeupdate — used to tell a genuine stall (time not
// advancing) from playback progress, so the buffering spinner isn't hidden the
// instant a freeze starts.
let lastProgressTime = -1;
// Consecutive advancing timeupdate ticks since the last 'waiting'. hls.js nudges
// currentTime forward by itself to jump small buffer holes while still stalled,
// which fires a single advancing timeupdate that isn't real resumed playback —
// requiring two in a row filters that one-off jump out.
let consecutiveAdvanceTicks = 0;

function shouldLoadFeedMedia(): boolean {
  if (!isInTweetList.value) return true;
  return props.mediaLoadState !== 'idle';
}

function markMediaLoadRequested() {
  mediaLoadEpoch += 1;
}

function canApplyQueuedRelease(releaseEpoch: number) {
  if (releaseEpoch !== mediaLoadEpoch) return false;
  if (!isInTweetList.value) return true;
  if (props.mediaLoadState === 'visible') return false;
  if (video.value && isCoordinatorPrimary(video.value)) return false;
  if (coordinatorAutoplayPending.value || isPlaying.value) return false;
  return true;
}

function debugVideoLoad(message: string) {
  if (!import.meta.env.DEV) return;
  console.debug(`[MEDIA VIDEO] ${message}`, {
    tweetId: props.tweet?.mid,
    mediaId: props.media.mid,
    fileName: props.media.fileName,
    type: props.media.type,
    state: props.mediaLoadState,
    primary: video.value ? isCoordinatorPrimary(video.value) : false,
  });
}

function cleanupHlsInstance() {
  if (hlsPlaylistProbeAbortController) {
    hlsPlaylistProbeAbortController.abort();
    hlsPlaylistProbeAbortController = null;
  }
  if (!hls) return;
  const mediaElement = hls.media;
  try {
    hls.detachMedia();
  } catch (e) {
    console.log('Error detaching HLS media:', e);
  }
  try {
    hls.destroy();
  } catch (e) {
    console.log('Error destroying HLS instance:', e);
  }
  hls = null;
  // After hls.destroy() revokes the internal blob URL, clear the video src
  // so the browser doesn't fire ERR_FILE_NOT_FOUND on the stale blob URL.
  if (mediaElement) {
    mediaElement.removeAttribute('src');
  }
}

function captureAndShowCoverFrame() {
  const el = video.value;
  const canvas = coverCanvas.value;
  if (!el || !canvas || el.readyState < 2 || !el.videoWidth || !el.videoHeight) return;
  const container = canvas.parentElement;
  const w = container?.clientWidth || el.clientWidth || el.videoWidth;
  const h = container?.clientHeight || el.clientHeight || el.videoHeight;
  if (!w || !h) return;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const videoAspect = el.videoWidth / el.videoHeight;
  const containerAspect = w / h;
  let sx = 0, sy = 0, sw = el.videoWidth, sh = el.videoHeight;
  if (videoAspect > containerAspect) {
    sw = el.videoHeight * containerAspect;
    sx = (el.videoWidth - sw) / 2;
  } else {
    sh = el.videoWidth / containerAspect;
    sy = (el.videoHeight - sh) / 2;
  }
  ctx.drawImage(el, sx, sy, sw, sh, 0, 0, w, h);
  hasCoverFrame.value = true;
}

function clearCoverFrame(force = false) {
  if (keepCoverUntilNextFragment && !force) return;
  if (force) keepCoverUntilNextFragment = false;
  hasCoverFrame.value = false;
}

function holdCurrentFrameUntilNextFragment() {
  captureAndShowCoverFrame();
  if (hasCoverFrame.value) {
    keepCoverUntilNextFragment = true;
  }
}

function cancelRegularVideoLoad() {
  const el = video.value;
  const releaseEpoch = mediaLoadEpoch;
  regularVideoActive.value = false;
  nextTick(() => {
    if (!canApplyQueuedRelease(releaseEpoch)) return;
    if (!el) return;
    try {
      if (!el.paused) el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {}
  });
}

function hasReusablePreloadBuffer() {
  const el = video.value;
  if (!el) return false;
  if (isHLS.value) {
    return el.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA || el.buffered.length > 0;
  }
  return el.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA && el.networkState !== HTMLMediaElement.NETWORK_LOADING;
}

function getViewportRatio(element: HTMLElement | null | undefined) {
  if (!element || typeof window === 'undefined') return 0;
  const rect = element.getBoundingClientRect();
  const height = rect.height || 1;
  const visibleTop = Math.max(rect.top, 0);
  const visibleBottom = Math.min(rect.bottom, window.innerHeight);
  return Math.max(0, visibleBottom - visibleTop) / height;
}

function isNearFeedPlaybackCandidate() {
  if (!isInTweetList.value) return false;
  return getViewportRatio(vdiv.value) >= 0.25;
}

function softReleaseFeedMedia(reason: string, options: { preserveRegularSource?: boolean } = {}) {
  debugVideoLoad(reason);
  captureAndShowCoverFrame();
  isPlaying.value = false;
  isBuffering.value = false;
  coordinatorAutoplayPending.value = false;
  showVideoError.value = false;
  try {
    if (!video.value?.paused) video.value.pause();
    applyCurrentFeedMutedState();
  } catch {}
  if (hls && !pendingUserPlayRequest) {
    hls.stopLoad();
  }
  if (isRegularVideo.value && regularVideoActive.value && !options.preserveRegularSource) {
    cancelRegularVideoLoad();
  }
}

function releaseFeedMedia(reason: string) {
  if (hasRenderedVideoFrame || hasCurrentFrame.value) {
    softReleaseFeedMedia(reason);
    return;
  }

  hardReleaseFeedMedia(reason);
}

function hardReleaseFeedMedia(reason: string) {
  debugVideoLoad(reason);
  const releaseEpoch = mediaLoadEpoch;
  hlsSetupToken += 1;
  keepCoverUntilNextFragment = false;
  captureAndShowCoverFrame();
  regularVideoActive.value = false;
  cleanupHlsInstance();
  isHLSInitialized = false;
  isPlaying.value = false;
  isBuffering.value = false;
  coordinatorAutoplayPending.value = false;
  hasMetadata.value = false;
  showVideoError.value = false;
  nextTick(() => {
    if (!canApplyQueuedRelease(releaseEpoch)) return;
    const el = video.value;
    if (!el) return;
    try {
      if (!el.paused) el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {}
  });
}

function cancelStalePreload() {
  if (!isInTweetList.value || props.mediaLoadState !== 'preload') return;
  if (video.value && isCoordinatorPrimary(video.value)) return;
  if (coordinatorAutoplayPending.value || isPlaying.value) return;
  if (isNearFeedPlaybackCandidate()) return;
  if (lastStalePreloadCancelEpoch === mediaLoadEpoch) return;
  const preserveReusableBuffer = hasReusablePreloadBuffer();
  lastStalePreloadCancelEpoch = mediaLoadEpoch;
  if (isHLS.value && hls) {
    softReleaseFeedMedia('pause stale hls preload');
    return;
  }
  if (preserveReusableBuffer) {
    softReleaseFeedMedia('pause stale preload', { preserveRegularSource: true });
    return;
  }
  hardReleaseFeedMedia('cancel stale preload');
}

onMounted(() => {
  isUnmounting = false;
  vdiv.value.hidden = false;
  
    // Setup video element immediately
    if (video.value && !isHLSInitialized) {
        if (isInTweetList.value) {
          applyCurrentFeedMutedState();
        } else {
          video.value.muted = getInitialMutedState();
        }
        syncMutedState();
        // If browser restored metadata/frame from cache before listeners were
        // attached, mark metadata ready immediately so initial-load spinner
        // logic does not get stuck.
        syncVideoReadyState();

        // Add play/pause event listeners to track state
        video.value.addEventListener('play', () => {
          isPlaying.value = true;
          hasUserPausedInFeed.value = false;
          showPlayOverlay.value = false;
          // Only show spinner if the video doesn't already have enough buffered data.
          // If it was preloaded, readyState >= HAVE_FUTURE_DATA means playback can
          // start immediately — no spinner needed.
          if (!video.value || video.value.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) {
            isBuffering.value = true;
          }
          updateTimeRemaining();
        });
        video.value.addEventListener('playing', () => {
          isBuffering.value = false;
          coordinatorAutoplayPending.value = false;
          clearCoverFrame();
          updateTimeRemaining();
          syncMutedState();
        });
        video.value.addEventListener('timeupdate', () => {
          updateTimeRemaining();
          // Clear a stale buffering flag ONLY when playback is genuinely
          // progressing (currentTime advanced). A buffer-underrun freeze fires
          // 'waiting' (isBuffering=true) but also emits a final timeupdate at the
          // buffer's edge — clearing on the isPlaying flag alone hid the spinner
          // the instant the freeze started. (Still unsticks isBuffering when
          // hls.js resumes without re-firing 'playing', since time then advances.)
          // Require two consecutive advancing ticks: hls.js's gap-nudge jumps
          // currentTime once by itself while still stalled to hop a buffer hole,
          // which looks like "advanced" for a single tick even though playback
          // hasn't actually resumed — clearing on that alone flashed the spinner
          // off immediately, right as the freeze continued.
          const t = video.value?.currentTime ?? 0;
          const advanced = t > lastProgressTime + 1e-3;
          lastProgressTime = t;
          consecutiveAdvanceTicks = advanced ? consecutiveAdvanceTicks + 1 : 0;
          if (isBuffering.value && consecutiveAdvanceTicks >= 2) {
            isBuffering.value = false;
          }
        });
        video.value.addEventListener('volumechange', syncMutedState);
        video.value.addEventListener('waiting', markVideoBuffering);
        video.value.addEventListener('stalled', markVideoBuffering);
        video.value.addEventListener('canplay', () => {
          syncVideoReadyState();
        });
        video.value.addEventListener('loadeddata', () => {
          syncVideoReadyState();
          clearCoverFrame();
        });
        video.value.addEventListener('canplaythrough', syncVideoReadyState);
        video.value.addEventListener('pause', (event: Event) => {
          isPlaying.value = false;
          isBuffering.value = false;
          coordinatorAutoplayPending.value = false;
          updateTimeRemaining();
          if (
            isInTweetList.value &&
            event.isTrusted &&
            video.value &&
            video.value.currentTime > 0 &&
            !video.value.ended
          ) {
            hasUserPausedInFeed.value = true;
          }
          // Don't show overlay if autoplay is enabled (use native controls)
          if (!props.autoplay) {
            showPlayOverlay.value = true;
          }
        });
        video.value.addEventListener('ended', () => {
          isPlaying.value = false;
          
          // Debug logging
          if (video.value) {
            console.log('🎬 VIDEO ENDED - Debug Info:', {
              fileName: props.media.fileName,
              mediaType: props.media.type,
              isHLS: isHLS.value,
              currentTime: video.value.currentTime,
              duration: video.value.duration,
              readyState: video.value.readyState,
              readyStateText: ['HAVE_NOTHING', 'HAVE_METADATA', 'HAVE_CURRENT_DATA', 'HAVE_FUTURE_DATA', 'HAVE_ENOUGH_DATA'][video.value.readyState],
              networkState: video.value.networkState,
              networkStateText: ['NETWORK_EMPTY', 'NETWORK_IDLE', 'NETWORK_LOADING', 'NETWORK_NO_SOURCE'][video.value.networkState],
              videoWidth: video.value.videoWidth,
              videoHeight: video.value.videoHeight,
              poster: video.value.poster,
              src: video.value.src ? video.value.src.substring(0, 100) + '...' : 'HLS',
              paused: video.value.paused,
              ended: video.value.ended,
              buffered: video.value.buffered.length > 0 ? {
                start: video.value.buffered.start(0),
                end: video.value.buffered.end(video.value.buffered.length - 1),
                length: video.value.buffered.length
              } : 'No buffered data'
            });
            
            // Check if HLS instance exists and has buffer info
            if (isHLS.value && hls) {
              console.log('🎬 HLS Buffer Info:', {
                levels: hls.levels?.length || 0,
                currentLevel: hls.currentLevel,
                loadLevel: hls.loadLevel,
                autoLevelEnabled: hls.autoLevelEnabled,
                media: hls.media ? 'attached' : 'detached'
              });
            }
          }
          
          // Keep video at the end, don't reset to beginning
          // This maintains the video container space (detail only; feed uses cover + outer aspect box)
          if (video.value && !isInTweetList.value) {
            video.value.style.minHeight = video.value.offsetHeight + 'px';
          }
          // Don't show overlay if autoplay is enabled (use native controls)
          if (!props.autoplay) {
            showPlayOverlay.value = true;
          }
        });
        
        // Add metadata loaded event listener (only once)
        video.value.addEventListener('loadedmetadata', () => {
          // Metadata loaded successfully - reset retry count and media error recovery count
          videoErrorRetryCount = 0;
          isRetryingVideo = false;
          lastHandledError = null;
          mediaErrorRecoveryCount = 0;
          lastMediaErrorTime = 0;
          hasTriedPlaylistFallback = false;
          showVideoError.value = false;
          failedFragments.clear();
          // Native controls can come up now that the spinner phase is over.
          hasMetadata.value = true;
          if (video.value) {
            if (!isInTweetList.value) {
              const videoHeight = video.value.videoHeight;
              const videoWidth = video.value.videoWidth;
              if (videoHeight > 0 && videoWidth > 0) {
                // Update wrapper aspect-ratio to match the actual video so the
                // wrapper hugs the frame — otherwise an inaccurate (or missing)
                // media.aspectRatio leaves black space above/below.
                measuredAspectRatio.value = videoWidth / videoHeight;
              }
            }
            updateTimeRemaining();
            syncMutedState();
          }
        }, { once: true });
        
        video.value.addEventListener('error', handleVideoError);
        
        // Add fullscreen change listeners
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
        document.addEventListener('mozfullscreenchange', handleFullscreenChange);
        document.addEventListener('MSFullscreenChange', handleFullscreenChange);
        
        // Load video immediately (no delay needed)
        if (isHLS.value && !isHLSInitialized) {
          if (!isInTweetList.value) {
            // Detail view: initialize immediately
            debugVideoLoad('load detail hls');
            setupHLS();
          } else if (props.mediaLoadState !== 'idle') {
            isBuffering.value = props.mediaLoadState === 'visible' && isCoordinatorPrimary(video.value);
            debugVideoLoad(props.mediaLoadState === 'visible' ? 'load visible hls' : 'preload hls');
            setupHLS();
          } else {
            // Feed: idle videos wait until visible/preloaded before attaching
            // network-heavy video sources.
            isBuffering.value = false;
          }
        } else if (isRegularVideo.value) {
          if (!isInTweetList.value) {
            // Detail view: attach the source and load immediately.
            debugVideoLoad('load detail mp4');
            setupRegularVideo();
          } else if (props.mediaLoadState !== 'idle') {
            regularVideoActive.value = true;
            isBuffering.value = props.mediaLoadState === 'visible' && isCoordinatorPrimary(video.value);
            debugVideoLoad(props.mediaLoadState === 'visible' ? 'load visible mp4' : 'preload mp4');
            nextTick(() => {
              if (!shouldLoadFeedMedia()) return;
              setupRegularVideo();
              video.value?.load();
            });
          } else {
            // Feed: wait for coordinator to mark this primary. Listeners
            // are attached in setupRegularVideo() once the source mounts.
            isBuffering.value = false;
          }
        }
        
        // Register with video playback coordinator for single-video-at-a-time in tweet list
        if (isInTweetList.value) {
          const onPrimaryChange: PrimaryChangeCallback = (isPrimary) => {
            if (isPrimary) {
              markMediaLoadRequested();
              // Don't set the pending flag for ended videos — the coordinator
              // won't auto-play them, so the play overlay should show instead.
              coordinatorAutoplayPending.value = !video.value?.ended;
              // Retry loading if the video previously failed
              if (showVideoError.value) {
                showVideoError.value = false;
                isBuffering.value = true;
                cleanupHlsInstance();
                isHLSInitialized = false;
                videoErrorRetryCount = 0;
                mediaErrorRecoveryCount = 0;
                lastMediaErrorTime = 0;
                hasTriedPlaylistFallback = false;
                failedFragments.clear();
                setupHLS();
                return;
              }
              // Auto-init HLS when coordinator scrolls this video into view.
              // The coordinator's own loadedmetadata listener (in setPrimary)
              // will call play() once metadata is available.
              if (!isHLSInitialized && isHLS.value) {
                isBuffering.value = true;
                debugVideoLoad('load primary hls');
                setupHLS();
                return;
              }
              if (isRegularVideo.value && !regularVideoActive.value) {
                // First time becoming primary: mount the <source>, attach
                // listeners, then call .load() to kick off buffering.
                regularVideoActive.value = true;
                isBuffering.value = true;
                debugVideoLoad('load primary mp4');
                nextTick(() => {
                  setupRegularVideo();
                  video.value?.load();
                });
                return;
              }
              if (hls) {
                hls.startLoad(-1);
                playFeedPrimaryVideo(video.value);
              }
            } else {
              coordinatorAutoplayPending.value = false;
              // Pause non-primary playback, but keep visible/preloaded media
              // attached so the user still sees its frame while scrolling.
              if (hls && !pendingUserPlayRequest) {
                hls.stopLoad();
              }
            }
          };
          registerVideo(video.value, vdiv.value, onPrimaryChange);
        }
      }
  
  // Add page visibility change listener
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener(TWEET_MEDIA_PRELOAD_STALE_EVENT, cancelStalePreload);
  
  // Add route change listener
  router.beforeEach((to, from, next) => {
    stopVideo();
    next();
  });
});

// In detail view, fetchTweet returns the tweet before the author resolves, then
// asynchronously updates media.mid to use author.providerIp. Watch for that
// change and restart HLS so the video loads from the correct server.
watch(() => props.media.mid, (newMid, oldMid) => {
  if (!isHLSInitialized || !isHLS.value || newMid === oldMid || isInTweetList.value) return;
  console.log(`[VideoJS] media.mid changed after HLS init, restarting: ${oldMid} → ${newMid}`);
  cleanupHlsInstance();
  isHLSInitialized = false;
  hasTriedPlaylistFallback = false;
  hasTriedSinglePlaylist = false;
  videoErrorRetryCount = 0;
  mediaErrorRecoveryCount = 0;
  lastMediaErrorTime = 0;
  failedFragments.clear();
  showVideoError.value = false;
  setupHLS();
});

watch(() => props.mediaLoadState, (state) => {
  if (!isInTweetList.value || !video.value) return;

  if (state === 'idle') {
    if (isCoordinatorPrimary(video.value)) return;
    debugVideoLoad('cancel idle');
    releaseFeedMedia('cancel idle');
    return;
  }

  markMediaLoadRequested();

  if (isHLS.value && !isHLSInitialized) {
    isBuffering.value = state === 'visible' && isCoordinatorPrimary(video.value);
    debugVideoLoad(state === 'visible' ? 'load visible hls' : 'preload hls');
    setupHLS();
    return;
  }

  if (isHLS.value && isHLSInitialized && !hls) {
    isHLSInitialized = false;
    isBuffering.value = state === 'visible' && isCoordinatorPrimary(video.value);
    debugVideoLoad(state === 'visible' ? 'reload visible hls' : 'reload preload hls');
    setupHLS();
    return;
  }

  if (isHLS.value && hls) {
    debugVideoLoad(state === 'visible' ? 'resume visible hls' : 'resume preload hls');
    hls.startLoad(-1);
    syncVideoReadyState();
    return;
  }

  if (isRegularVideo.value && !regularVideoActive.value) {
    regularVideoActive.value = true;
    isBuffering.value = state === 'visible' && isCoordinatorPrimary(video.value);
    debugVideoLoad(state === 'visible' ? 'load visible mp4' : 'preload mp4');
    nextTick(() => {
      if (!shouldLoadFeedMedia()) return;
      setupRegularVideo();
      video.value?.load();
    });
  }
});

onUnmounted(() => {
  isUnmounting = true;
  // Clean up event listeners
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  document.removeEventListener('fullscreenchange', handleFullscreenChange);
  document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
  document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
  document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
  window.removeEventListener(TWEET_MEDIA_PRELOAD_STALE_EVENT, cancelStalePreload);

  if (video.value) {
    video.value.removeEventListener('error', handleVideoError);
    video.value.removeEventListener('timeupdate', updateTimeRemaining);
  }
  
  // Unregister from video playback coordinator
  if (video.value) {
    unregisterVideo(video.value);
  }
  
  // Stop video and clean up HLS
  stopVideo();
});

function setupHLS() {
  if (!video.value || isHLSInitialized) return;
  if (!shouldLoadFeedMedia()) return;
  markMediaLoadRequested();
  isHLSInitialized = true;
  const setupToken = ++hlsSetupToken;
  
  const videoElement = video.value;

      // Enable hardware acceleration if supported
    if (supportsHardwareAcceleration) {
      videoElement.style.transform = 'translateZ(0)'; // Force hardware acceleration
      videoElement.style.willChange = 'transform'; // Optimize for animations
    }
  
  // Check if HLS is supported natively (Safari only - other browsers need hls.js)
  // Only use native HLS if canPlayType returns 'probably' (Safari) not just truthy (Chrome/Edge return 'maybe')
  const nativeHLS = videoElement.canPlayType('application/vnd.apple.mpegurl');
  const isSafari = /^((?!chrome|android|edg).)*safari/i.test(navigator.userAgent) || 
                   (/iPad|iPhone|iPod/.test(navigator.userAgent) && !(window as any).MSStream);
  const useNativeHLS = isSafari && nativeHLS === 'probably';
  
  if (useNativeHLS) {
    const cachedFilename = getCachedPlaylistFilename();
    const masterUrl = getHLSMasterSource();
    const playlistUrl = getHLSSource();

    if (cachedFilename) {
      const cachedUrl = cachedFilename === 'master.m3u8' ? masterUrl : playlistUrl;
      console.log(`Native HLS: Using cached playlist ${cachedFilename}`);
      videoElement.src = cachedUrl;
      videoElement.load();

      videoElement.addEventListener('error', () => {
        if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;
        console.log(`Native HLS: Cached ${cachedFilename} failed, falling back to hls.js`);
        videoElement.src = '';
        videoElement.load();
        if (Hls.isSupported()) {
          setupHLSWithJS(videoElement, setupToken);
        } else {
          console.error('Native HLS failed and hls.js is not supported, cannot play HLS video');
        }
      }, { once: true });
    } else {
      void (async () => {
        const winner = await selectHLSPlaylistSimultaneously([
          { fileName: 'master.m3u8', sourceName: 'master', url: masterUrl },
          { fileName: 'playlist.m3u8', sourceName: 'playlist', url: playlistUrl },
        ]);
        if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;

        const selected = winner ?? { fileName: 'master.m3u8' as const, sourceName: 'master' as const, url: masterUrl };
        if (winner) {
          console.log(`Native HLS: Using first valid playlist ${winner.fileName}`);
          cacheResolvedPlaylistFilename(winner.fileName);
        } else {
          console.log('Native HLS: Playlist probes failed, trying master playlist');
        }
        videoElement.src = selected.url;
        videoElement.load();

        videoElement.addEventListener('error', () => {
          if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;
          const fallbackFilename = selected.fileName === 'master.m3u8' ? 'playlist.m3u8' : 'master.m3u8';
          const fallbackUrl = fallbackFilename === 'master.m3u8' ? masterUrl : playlistUrl;
          console.log(`Native HLS: ${selected.fileName} failed, trying ${fallbackFilename}`);
          clearCachedPlaylistFilename(selected.fileName);
          cacheResolvedPlaylistFilename(fallbackFilename);
          videoElement.src = fallbackUrl;
          videoElement.load();

          videoElement.addEventListener('error', () => {
            if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;
            console.log('Native HLS: Both playlists failed, falling back to hls.js');
            clearCachedPlaylistFilename(fallbackFilename);
            videoElement.src = '';
            videoElement.load();
            if (Hls.isSupported()) {
              setupHLSWithJS(videoElement, setupToken);
            } else {
              console.error('Native HLS failed and hls.js is not supported, cannot play HLS video');
            }
          }, { once: true });
        }, { once: true });
      })();
    }
  } else if (Hls.isSupported()) {
    // Use hls.js for all non-Safari browsers or when native HLS is not available
    setupHLSWithJS(videoElement, setupToken);
  } else {
    console.error('HLS is not supported in this browser');
    showVideoError.value = true;
    isBuffering.value = false;
    coordinatorAutoplayPending.value = false;
  }
}

async function probeHLSPlaylist(candidate: HLSPlaylistCandidate, signal: AbortSignal): Promise<HLSPlaylistCandidate> {
  const response = await fetch(candidate.url, { signal, cache: 'default' });
  if (!response.ok) {
    throw new Error(`${candidate.fileName} returned ${response.status}`);
  }
  const text = await response.text();
  if (!text.trimStart().startsWith('#EXTM3U')) {
    throw new Error(`${candidate.fileName} is not an HLS manifest`);
  }
  return candidate;
}

function raceHLSPlaylistProbes(
  candidates: HLSPlaylistCandidate[],
  signal: AbortSignal,
): Promise<HLSPlaylistCandidate | null> {
  return new Promise((resolve) => {
    let pending = candidates.length;
    let settled = false;

    candidates.forEach((candidate) => {
      probeHLSPlaylist(candidate, signal)
        .then((winner) => {
          if (settled) return;
          settled = true;
          resolve(winner);
        })
        .catch((error) => {
          if (!signal.aborted) {
            console.log(`HLS.js: ${candidate.fileName} playlist probe failed`, error);
          }
          pending -= 1;
          if (!settled && pending === 0) {
            settled = true;
            resolve(null);
          }
        });
    });
  });
}

async function selectHLSPlaylistSimultaneously(candidates: HLSPlaylistCandidate[]): Promise<HLSPlaylistCandidate | null> {
  hlsPlaylistProbeAbortController?.abort();
  const controller = new AbortController();
  hlsPlaylistProbeAbortController = controller;

  console.log('HLS.js: Probing master.m3u8 and playlist.m3u8 simultaneously');
  try {
    const winner = await raceHLSPlaylistProbes(candidates, controller.signal);
    if (winner) {
      controller.abort();
    }
    return winner;
  } finally {
    if (hlsPlaylistProbeAbortController === controller) {
      hlsPlaylistProbeAbortController = null;
    }
  }
}

// Setup HLS using hls.js library
function setupHLSWithJS(videoElement: HTMLVideoElement, setupToken: number) {
    // Configure HLS.js based on context (list vs detail) with hardware acceleration
    const hlsConfig = isInTweetList.value ? {
      enableWorker: true,
      lowLatencyMode: false,
      abrEwmaDefaultEstimate: 500000,
      abrBandWidthFactor: 0.9,
      abrBandWidthUpFactor: 0.65,
      abrMaxWithRealBitrate: true,
      startLevel: 0,
      capLevelToPlayerSize: true,
      maxBufferLength: isMobile ? 15 : 30,
      maxMaxBufferLength: isMobile ? 60 : 180,
      // Mobile keeps a smaller buffer to reduce initial-load latency.
      maxBufferSize: isMobile ? 10 * 1000 * 1000 : 60 * 1000 * 1000,
      maxBufferHole: 0.5,
      enableSoftwareAES: false,
      enableStashBuffer: true,
      stashInitialSize: isMobile ? 128 * 1024 : 512 * 1024,
    } : {
      enableWorker: true,
      // lowLatencyMode causes aggressive pre-fetching that hurts first-load on mobile.
      lowLatencyMode: !isMobile,
      abrEwmaDefaultEstimate: 500000,
      abrBandWidthFactor: 0.95,
      abrBandWidthUpFactor: 0.7,
      abrMaxWithRealBitrate: true,
      // Start at lowest quality on mobile for faster initial frame.
      startLevel: isMobile ? 0 : -1,
      capLevelToPlayerSize: true,
      maxBufferLength: 30,
      maxMaxBufferLength: 600,
      maxBufferSize: isMobile ? 15 * 1000 * 1000 : 60 * 1000 * 1000,
      maxBufferHole: 0.5,
      progressive: true,
      startFragPrefetch: true,
      enableSoftwareAES: false,
      enableStashBuffer: true,
      stashInitialSize: isMobile ? 128 * 1024 : 384 * 1024,
      enableWebAssembly: true,
      backBufferLength: 90,
    };
    
    const masterUrl = getHLSMasterSource();
    const playlistUrl = getHLSSource();
    
    // Helper function to create and attach HLS instance
    const createHLSInstance = (url: string, sourceName: HLSPlaylistSourceName) => {
      if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;
      // Clean up any existing HLS instance
      cleanupHlsInstance();
      
      // Create new HLS instance
      console.log(`HLS.js: Creating instance with ${sourceName} playlist`);
      hls = new Hls(hlsConfig);
      hls.loadSource(url);
      hls.attachMedia(videoElement);
      let loggedFirstFragLoaded = false;
      
      // Handle manifest parsed
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) {
          hls?.stopLoad();
          return;
        }
        console.log(`HLS.js: ${sourceName} playlist manifest parsed successfully`);
        // Track which playlist type we're using
        currentPlaylistType = sourceName;
        cacheResolvedPlaylistFilename(sourceName === 'master' ? 'master.m3u8' : 'playlist.m3u8');
        // Reset media error recovery counter on successful manifest parse
        mediaErrorRecoveryCount = 0;
        lastMediaErrorTime = 0;
        showVideoError.value = false;
        if (!coordinatorAutoplayPending.value) {
          isBuffering.value = false;
        }
        failedFragments.clear();
        if (isInTweetList.value && isCoordinatorPrimary(videoElement)) {
          pendingUserPlayRequest = false;
          playFeedPrimaryVideo(videoElement);
          return;
        }
        if (props.autoplay || pendingUserPlayRequest) {
          pendingUserPlayRequest = false;
          if (isInTweetList.value) {
            if (!isCoordinatorPrimary(videoElement)) {
              isBuffering.value = false;
              coordinatorAutoplayPending.value = false;
              return;
            }
            playFeedPrimaryVideo(videoElement);
            return;
          }
          videoElement.play().catch(() => {
            isBuffering.value = false;
            coordinatorAutoplayPending.value = false;
            showPlayOverlay.value = true;
          });
        }
      });

      hls.on(Hls.Events.FRAG_LOADED, () => {
        if (loggedFirstFragLoaded) return;
        loggedFirstFragLoaded = true;
        if (!isInTweetList.value) {
          window.dispatchEvent(new CustomEvent(TWEET_DETAIL_MEDIA_READY_EVENT, {
            detail: { mediaId: props.media.mid },
          }));
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;
        syncVideoReadyState();
        clearCoverFrame(true);
      });

      hls.on(Hls.Events.BUFFER_APPENDED, () => {
        if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;
        syncVideoReadyState();
      });
      
      // Error handling for the instance
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) {
          hls?.stopLoad();
          return;
        }
        // fragParsingError is expected for some corrupted/incompatible segments
        // and is already recovered from below without affecting playback -
        // logging it every time is just noise.
        if (data.fatal || data.details !== 'fragParsingError') {
          console.log(`HLS Error (${sourceName}):`, data);
        }

        if (data.fatal && sourceName === 'master' && !hasTriedPlaylistFallback) {
          console.log('HLS.js: master playlist failed, trying playlist.m3u8');
          hasTriedPlaylistFallback = true;
          clearCachedPlaylistFilename('master.m3u8');
          cleanupHlsInstance();
          mediaErrorRecoveryCount = 0;
          lastMediaErrorTime = 0;
          createHLSInstance(getHLSSource(), 'playlist');
          return;
        }

        if (data.fatal && sourceName === 'playlist' && !hasTriedSinglePlaylist) {
          console.log('HLS.js: playlist.m3u8 failed, trying master.m3u8');
          hasTriedSinglePlaylist = true;
          clearCachedPlaylistFilename('playlist.m3u8');
          cleanupHlsInstance();
          mediaErrorRecoveryCount = 0;
          lastMediaErrorTime = 0;
          createHLSInstance(getHLSMasterSource(), 'master');
          return;
        }

        // For non-fatal errors, try to recover
        if (!data.fatal) {
          // levelSwitchError: invalid level index (e.g. stream has fewer levels
          // than startLevel). Fall back to auto level selection.
          if (data.details === 'levelSwitchError' && hls) {
            console.log('Level switch error, falling back to auto level selection');
            hls.currentLevel = -1;
            hls.startLoad();
            return;
          }

          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('Network error, attempting to recover...');
              hls?.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              // Buffer stall/nudge errors are handled internally by HLS.js
              // (it continues buffering or nudges currentTime). Calling
              // recoverMediaError() on top resets the MediaSource and
              // causes a visible video restart.
              if (data.details === 'bufferStalledError' || data.details === 'bufferNudgeOnStall') {
                return;
              }

              // For fragment parsing errors, track and recover to skip to next segment
              // This allows playback to continue even with some corrupted/incompatible segments (like iOS does)
              if (data.details === 'fragParsingError') {
                const fragUrl = data.frag?.url || 'unknown';
                const fragEnd = data.frag?.end;
                const fragStart = data.frag?.start;
                const fragDuration = data.frag?.duration;
                const hasFragEnd = typeof fragEnd === 'number' && Number.isFinite(fragEnd);
                const hasFragRange =
                  typeof fragStart === 'number' &&
                  typeof fragDuration === 'number' &&
                  Number.isFinite(fragStart) &&
                  Number.isFinite(fragDuration);
                const nextLoadPosition = hasFragEnd
                  ? fragEnd
                  : hasFragRange
                    ? fragStart + fragDuration
                    : videoElement.currentTime + 0.5;

                holdCurrentFrameUntilNextFragment();

                // Check if we've already tried to recover this fragment
                if (failedFragments.has(fragUrl)) {
                  hls?.startLoad(nextLoadPosition);
                  return;
                }

                // Mark this fragment as failed and skip forward without
                // recoverMediaError(); that resets MediaSource and briefly
                // blanks the visible video.
                failedFragments.add(fragUrl);
                hls?.startLoad(nextLoadPosition);
                return;
              }

              // For other media errors (bufferSeekOverHole, etc.), use recovery logic
              const now = Date.now();
              const timeSinceLastError = now - lastMediaErrorTime;

              // Check if we're within cooldown period
              if (timeSinceLastError < MEDIA_ERROR_COOLDOWN) {
                console.log(`Media error cooldown active (${timeSinceLastError}ms < ${MEDIA_ERROR_COOLDOWN}ms), skipping recovery`);
                return;
              }

              // Check if we've exceeded max recovery attempts
              if (mediaErrorRecoveryCount >= MAX_MEDIA_ERROR_RECOVERIES) {
                console.error(`Media error: Max recovery attempts (${MAX_MEDIA_ERROR_RECOVERIES}) reached`);

                // Try fallback to alternative playlist if we haven't tried it yet
                if (!hasTriedPlaylistFallback && currentPlaylistType === 'master') {
                  console.log('Attempting fallback to playlist.m3u8...');
                  hasTriedPlaylistFallback = true;

                  // Destroy current HLS instance
                  cleanupHlsInstance();

                  // Reset counters for new attempt
                  mediaErrorRecoveryCount = 0;
                  lastMediaErrorTime = 0;

                  // Try the playlist URL
                  const playlistUrl = getHLSSource();
                  createHLSInstance(playlistUrl, 'playlist');
                  return;
                }

                // If fallback also failed or we were already on playlist, give up
                console.error('All recovery attempts exhausted, stopping playback');
                if (hls) {
                  console.log('Destroying HLS instance to stop error loop');
                  cleanupHlsInstance();
                }
                // Show error message to user
                showVideoError.value = true;
                isBuffering.value = false;
                coordinatorAutoplayPending.value = false;
                return;
              }

              mediaErrorRecoveryCount++;
              lastMediaErrorTime = now;
              console.log(`Media error, attempting to recover (${mediaErrorRecoveryCount}/${MAX_MEDIA_ERROR_RECOVERIES})...`);
              hls?.recoverMediaError();
              break;
          }
        } else {
          console.log(`HLS fatal error on ${sourceName}, attempting retry...`);
          handleHLSFatalError(data, sourceName, url, videoElement);
        }
      });
    };
    
    const cachedFilename = getCachedPlaylistFilename();
    if (cachedFilename) {
      const cachedUrl = cachedFilename === 'master.m3u8' ? masterUrl : playlistUrl;
      const cachedSourceName = cachedFilename === 'master.m3u8' ? 'master' : 'playlist';
      console.log(`HLS.js: Using cached playlist ${cachedFilename}`);
      createHLSInstance(cachedUrl, cachedSourceName);
      return;
    }

    void (async () => {
      const winner = await selectHLSPlaylistSimultaneously([
        { fileName: 'master.m3u8', sourceName: 'master', url: masterUrl },
        { fileName: 'playlist.m3u8', sourceName: 'playlist', url: playlistUrl },
      ]);
      if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;

      if (winner) {
        console.log(`HLS.js: Using first valid playlist ${winner.fileName}`);
        cacheResolvedPlaylistFilename(winner.fileName);
        createHLSInstance(winner.url, winner.sourceName);
        return;
      }

      console.log('HLS.js: Playlist probes failed, trying master playlist first');
      createHLSInstance(masterUrl, 'master');
    })();
}

// Setup regular video playback (non-HLS)
function setupRegularVideo() {
  if (!video.value) return;
  markMediaLoadRequested();

  const videoElement = video.value;

  // Enable hardware acceleration if supported
  if (supportsHardwareAcceleration) {
    videoElement.style.transform = 'translateZ(0)'; // Force hardware acceleration
    videoElement.style.willChange = 'transform'; // Optimize for animations
  }

  // Add error handling for regular video
  videoElement.addEventListener('error', handleVideoError);

  // Add load event to confirm video loaded
  videoElement.addEventListener('loadeddata', () => {
    syncVideoReadyState();
    clearCoverFrame();
  }, { once: true });

  // Add canplay event and start playing if autoplay is enabled
  videoElement.addEventListener('canplay', () => {
    syncVideoReadyState();
    if (props.autoplay && !isInTweetList.value) {
      videoElement.play().catch(() => {
        // Autoplay blocked — drop back to the centered play overlay.
        showPlayOverlay.value = true;
      });
    }
  }, { once: true });

  // Force the browser to (re)load whatever <source> is currently mounted.
  // Vue may have rendered the <source> element AFTER the <video> mounted —
  // without this call the browser sometimes never starts loading.
  try { videoElement.load(); } catch {}
  window.requestAnimationFrame(syncVideoReadyState);

  // Try to play immediately if autoplay is enabled
  if (props.autoplay && !isInTweetList.value) {
    videoElement.play().catch(() => {
      // Autoplay blocked — clear the spinner so the user sees the play
      // overlay instead of an indefinite loading state.
      isBuffering.value = false;
      showPlayOverlay.value = true;
    });
  }
}

// Handle autoplay with proper error handling and user interaction detection
async function handleAutoplay(videoElement: HTMLVideoElement) {
  try {
    // Check if autoplay is allowed
    const canAutoplay = await checkAutoplaySupport(videoElement);
    
    if (canAutoplay) {
      await videoElement.play();
      isPlaying.value = true;
      showPlayOverlay.value = false;
    } else {
      // Show play button or other UI indication that user needs to interact
      showAutoplayBlockedUI();
    }
  } catch (error) {
    // Show play button or other UI indication
    showAutoplayBlockedUI();
  }
}

// Check if autoplay is supported by the browser
async function checkAutoplaySupport(videoElement: HTMLVideoElement): Promise<boolean> {
  try {
    // Try to play a silent video to test autoplay support
    videoElement.muted = true;
    videoElement.volume = 0;
    
    // Create a promise that resolves when play() succeeds or rejects
    const playPromise = videoElement.play();
    
    if (playPromise !== undefined) {
      await playPromise;
      // If we get here, autoplay worked
      videoElement.pause();
      return true;
    }
    return false;
  } catch (error) {
    return false;
  }
}

// Show UI indication that autoplay is blocked
function showAutoplayBlockedUI() {
  autoplayBlocked.value = true;
}

// Handle manual play when autoplay is blocked
async function handleManualPlay() {
  try {
    if (video.value) {
      await video.value.play();
      isPlaying.value = true;
      autoplayBlocked.value = false;
    }
  } catch (error) {
    // Silent error handling
  }
}

function getVideoSource(): string {
  // For regular videos, use the existing logic
  return props.media.mid + '#t=1';
}

function getHLSSource(): string {
  const baseUrl = getBaseMediaUrl();
  return baseUrl + '/playlist.m3u8';
}

function getHLSMasterSource(): string {
  const baseUrl = getBaseMediaUrl();
  return baseUrl + '/master.m3u8';
}

function getCachedPlaylistFilename(): HLSPlaylistFilename | null {
  // Check the global cross-instance cache first so a freshly-mounted detail
  // view skips the probe when the feed already resolved the same stream.
  const baseUrl = getBaseMediaUrl();
  const global = globalPlaylistFilenameCache.get(baseUrl);
  if (global === 'master.m3u8' || global === 'playlist.m3u8') {
    console.log(`[HLS Playlist Cache] HIT (global) for ${baseUrl}: ${global}`);
    // Also seed the per-prop cache for any future reads on this object.
    if (props.media.playlist !== global) props.media.playlist = global;
    return global;
  }
  const cached = props.media.playlist;
  if (cached === 'master.m3u8' || cached === 'playlist.m3u8') {
    console.log(`[HLS Playlist Cache] HIT (prop) for media ${props.media.mid}: ${cached}`);
    globalPlaylistFilenameCache.set(baseUrl, cached);
    return cached;
  }
  console.log(`[HLS Playlist Cache] MISS for media ${props.media.mid}`);
  return null;
}

function cacheResolvedPlaylistFilename(fileName: HLSPlaylistFilename) {
  const baseUrl = getBaseMediaUrl();
  globalPlaylistFilenameCache.set(baseUrl, fileName);
  if (props.media.playlist !== fileName) {
    props.media.playlist = fileName;
    console.log(`[HLS Playlist Cache] STORE for media ${props.media.mid}: ${fileName}`);
  }
}

function clearCachedPlaylistFilename(fileName: HLSPlaylistFilename) {
  const baseUrl = getBaseMediaUrl();
  if (globalPlaylistFilenameCache.get(baseUrl) === fileName) {
    globalPlaylistFilenameCache.delete(baseUrl);
  }
  if (props.media.playlist === fileName) {
    delete props.media.playlist;
  }
}

function getBaseMediaUrl(): string {
  // If props.media.mid is already a full URL, use it as-is
  if (props.media.mid.startsWith('http://') || props.media.mid.startsWith('https://')) {
    return props.media.mid;
  }
  
  // Otherwise, construct the full URL from the hash using tweetStore.getMediaUrl
  // Try to get provider IP from tweet author
  let baseUrl = '';
  if (props.tweet?.author?.providerIp) {
    baseUrl = `http://${props.tweet.author.providerIp}`;
  } else if (props.tweet?.provider) {
    baseUrl = `http://${props.tweet.provider}`;
  } else {
    // Fallback to current origin (shouldn't happen in normal flow)
    baseUrl = window.location.origin;
  }
  
  // Use tweetStore.getMediaUrl to construct the URL (handles /ipfs/ vs /mm/ logic)
  return tweetStore.getMediaUrl(props.media.mid, baseUrl);
}

// Fallback to progressive video when HLS streaming fails
function fallbackToProgressiveVideo(videoElement: HTMLVideoElement) {
  console.log('Falling back to progressive video format');
  
  // Destroy HLS instance
  if (hls) {
    try {
      hls.destroy();
    } catch (e) {
      console.log('Error destroying HLS during fallback:', e);
    }
    hls = null;
  }
  
  // Reset retry state for progressive video
  videoErrorRetryCount = 0;
  isRetryingVideo = false;
  lastHandledError = null;
  
  // Remove any existing sources
  while (videoElement.firstChild) {
    videoElement.removeChild(videoElement.firstChild);
  }
  
  // Clear current source
  videoElement.src = '';
  
  // Set the video source to the original URL without extension
  // This will attempt to play the video as a progressive download
  const progressiveUrl = props.media.mid;
  
  // Small delay to ensure cleanup is complete
  setTimeout(() => {
    if (videoElement) {
      videoElement.src = progressiveUrl;
      videoElement.load();
      
      // Add load event to confirm progressive video loaded
      videoElement.addEventListener('loadeddata', () => {
        console.log('Progressive video loaded successfully');
        videoErrorRetryCount = 0;
        isRetryingVideo = false;
        lastHandledError = null;
      }, { once: true });
      
      // Add canplay event
      videoElement.addEventListener('canplay', () => {
        console.log('Progressive video can play');
      }, { once: true });
      
      // Try to play the video
      if (props.autoplay && !isInTweetList.value) {
        videoElement.play().catch(error => {
          console.log('Autoplay failed for progressive video:', error);
        });
      }
    }
  }, 100);
}


// Detect if device is mobile browser
function isMobileBrowser(): boolean {
  // Check for touch capability and screen width
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const isSmallScreen = window.innerWidth <= 768;
  return hasTouch && isSmallScreen;
}

// Check if click is on video control area
function isControlArea(clickY: number, videoHeight: number): boolean {
  const controlsArea = videoHeight * 0.15; // Bottom 15% is controls area
  return clickY > videoHeight - controlsArea;
}

// Open media viewer
function openMediaViewer() {
  console.log('VideoJS: openMediaViewer called');
  console.log('VideoJS: props.tweet:', props.tweet);
  console.log('VideoJS: props.mediaList:', props.mediaList);
  console.log('VideoJS: props.mediaIndex:', props.mediaIndex);
  
  // Try to get tweet from props, or find it from the DOM
  let tweet = props.tweet;
  let allMedia = props.mediaList;
  
  // If tweet not in props, try to find it from parent container
  if (!tweet && vdiv.value) {
    const tweetContainer = vdiv.value.closest('.tweet-container');
    if (tweetContainer) {
      // Try to get tweet data from data attributes or find the tweet store
      const tweetId = tweetContainer.id;
      // For now, we'll use the mediaList if available
    }
  }
  
  // If still no media list, try to get from tweet attachments
  if (!allMedia && tweet) {
    allMedia = tweet.attachments || [];
  }
  
  // If we still don't have media, create a single-item list
  if (!allMedia || allMedia.length === 0) {
    allMedia = [props.media];
  }
  
  // Find current video index
  const currentIndex = props.mediaIndex !== undefined 
    ? props.mediaIndex 
    : allMedia.findIndex(media => media.mid === props.media.mid);
  
  console.log('VideoJS: Final media list:', allMedia);
  console.log('VideoJS: Current index:', currentIndex);
  
  // Store media data in session storage for the modal
  const mediaViewerData = {
    mediaList: allMedia,
    initialIndex: currentIndex >= 0 ? currentIndex : 0,
    tweet: tweet || null
  };
  
  console.log('VideoJS: Storing media viewer data:', mediaViewerData);
  sessionStorage.setItem('mediaViewerData', JSON.stringify(mediaViewerData));
  
  // Navigate to media viewer
  console.log('VideoJS: Navigating to media viewer');
  router.push('/media-viewer');
}

// Handle touch start for scroll detection
function handleTouchStart(event: TouchEvent) {
  if (!isMobileBrowser()) return;
  
  if (event.touches.length === 1) {
    touchStartX.value = event.touches[0].clientX;
    touchStartY.value = event.touches[0].clientY;
    touchStartTime.value = Date.now();
    isScrolling.value = false;
  }
}

// Handle touch move to detect scrolling
function handleTouchMove(event: TouchEvent) {
  if (!isMobileBrowser()) return;
  
  if (event.touches.length === 1 && touchStartX.value !== 0) {
    const deltaX = Math.abs(event.touches[0].clientX - touchStartX.value);
    const deltaY = Math.abs(event.touches[0].clientY - touchStartY.value);
    
    // If movement is significant (more than 10px), it's a scroll
    if (deltaX > 10 || deltaY > 10) {
      isScrolling.value = true;
    }
  }
}

// Handle touch end
function handleTouchEnd(event: TouchEvent) {
  if (!isMobileBrowser()) return;
  
  // If user was scrolling, don't open media viewer
  if (isScrolling.value) {
    isScrolling.value = false;
    touchStartX.value = 0;
    touchStartY.value = 0;
    return;
  }
  
  // Check if it was a quick tap (less than 300ms)
  const touchDuration = Date.now() - touchStartTime.value;
  if (touchDuration > 300) {
    // Too long, probably not a tap
    touchStartX.value = 0;
    touchStartY.value = 0;
    return;
  }
  
  // It's a tap, handle it
  handleVideoTap(event);
  
  touchStartX.value = 0;
  touchStartY.value = 0;
}

// Handle video element tap/click
function handleVideoTap(event: Event) {
  const mouseEvent = event as MouseEvent | TouchEvent;
  const target = event.target as HTMLElement;
  
  if (!video.value) {
    console.log('VideoJS: handleVideoTap - no video element');
    return;
  }
  
  // In fullscreen the browser's native controls handle tap-to-show/hide.
  // Don't intercept — let the event fall through to the video element.
  if (isFullscreenActive.value) return;

  // Mobile: any tap that reaches this handler means the user tapped the video
  // area (not an overlay control, which intercepts its own touches via DOM
  // order). Always open device fullscreen.
  if (isMobileBrowser()) {
    event.preventDefault();
    event.stopPropagation();
    // Ensure HLS is loading/playing before entering fullscreen.
    if (isHLS.value && !isHLSInitialized) {
      // Not yet loaded — init HLS; manifest parsed handler will play via pendingUserPlayRequest.
      pendingUserPlayRequest = true;
      isBuffering.value = true;
      showVideoError.value = false;
      setupHLS();
    } else if (isRegularVideo.value && !regularVideoActive.value && isInTweetList.value) {
      regularVideoActive.value = true;
      pendingUserPlayRequest = true;
      nextTick(() => { setupRegularVideo(); video.value?.load(); });
    } else if (video.value?.paused) {
      // Video already has data — play NOW while still inside the user gesture
      // so iOS Safari grants the play permission before fullscreen steals context.
      video.value.play().catch(() => {
        video.value!.muted = true;
        video.value!.play().catch(() => {});
      });
    }
    requestFullscreen();
    return;
  }
  
  // Desktop behavior - get click position
  const rect = video.value.getBoundingClientRect();
  const clickY = (mouseEvent as MouseEvent).clientY - rect.top;
  const clickX = (mouseEvent as MouseEvent).clientX - rect.left;
  const videoHeight = rect.height;
  const videoWidth = rect.width;
  
  // Check if click is on control area (bottom 15% of video)
  const isOnControls = isControlArea(clickY, videoHeight);
  
  // Check if controls are visible (video is playing or has been interacted with)
  const controlsVisible = !video.value.paused || video.value.currentTime > 0;

  if (!controlsVisible) {
    // Controls not visible - show them and play
    event.preventDefault();
    event.stopPropagation();

    // Focus video to show controls
    video.value.focus();

    // Play the video
    if (video.value.paused) {
      video.value.play().catch(() => {
        // If autoplay fails, try muted
        video.value.muted = true;
        video.value.play().catch(() => {});
      });
    }

    // Tell coordinator this is now the active video (pauses all others)
    if (video.value) {
      requestPlay(video.value);
    }

    return;
  } else {
    // Controls are visible
    if (isOnControls) {
      // Click is on controls - let native controls handle it
      console.log('VideoJS: Tapping on controls, letting native handle');
      return;
    } else {
      // Click is on video area (not controls)
      if (showControls) {
        // Desktop in detail view: toggle play/pause
        console.log('VideoJS: Desktop detail view - toggling play/pause');
        event.preventDefault();
        event.stopPropagation();
        if (video.value) {
          if (video.value.paused) {
            video.value.play().catch(() => {
              video.value!.muted = true;
              video.value!.play().catch(() => {});
            });
          } else {
            video.value.pause();
          }
        }
        return;
      } else {
        // Feed context: open the in-app media viewer (like images), not native
        // fullscreen.
        event.preventDefault();
        event.stopPropagation();
        openMediaViewer();
        return;
      }
    }
  }
}

// Helper function to play video after fullscreen
async function playAfterFullscreen() {
  if (!video.value) return;
  
  // Wait a bit for fullscreen to fully activate
  await new Promise(resolve => setTimeout(resolve, 150));
  
  // Now play the video - ensure it plays
  if (video.value) {
    try {
      await video.value.play();
      // Ensure playing state is updated
      if (video.value.paused) {
        // If still paused, try again
        await video.value.play();
      }
      isPlaying.value = true;
      showPlayOverlay.value = false;
    } catch (playError) {
      // If autoplay fails, try muted first
      video.value.muted = true;
      await video.value.play();
      isPlaying.value = true;
      showPlayOverlay.value = false;
      setTimeout(() => {
        if (video.value) {
          video.value.muted = false;
        }
      }, 100);
    }
  }
}

// Handle play overlay click
function handlePlayOverlayClick(event: Event) {
  event.stopPropagation();
  event.preventDefault();
  if (video.value) {
    if (isHLS.value && !isHLSInitialized) {
      // Lazy-init HLS in feed and immediately request play once manifest is ready.
      pendingUserPlayRequest = true;
      isBuffering.value = true;
      showVideoError.value = false;
      setupHLS();
      return;
    }
    if (isPlaying.value) {
      video.value.pause();
    } else {
      // Play inline on all platforms — fullscreen is triggered by tapping
      // the video area (handleVideoTap), not the play button.
      if (video.value.ended || video.value.currentTime >= video.value.duration) {
        video.value.currentTime = 0;
      }
      requestPlay(video.value);
      video.value.play().catch(() => {
        video.value!.muted = true;
        video.value!.play().catch(() => {});
      });
    }
  }
}

function checkVideoOrientation() {
  const videoElement = video.value;
  if (videoElement && (videoElement.videoWidth < videoElement.videoHeight)) {
    isPortrait.value = true;
  } else {
    isPortrait.value = false;
  }
}

function disableRightClick(event: MouseEvent) {
  if (props.media.downloadable == false)
    event.preventDefault();
}

// Handle page visibility change
function handleVisibilityChange() {
  if (document.hidden) {
    stopVideo();
  }
}

// Request fullscreen for video
async function requestFullscreen() {
  if (!video.value) return;

  // Lock the current HLS quality level before the player resizes.
  // capLevelToPlayerSize would otherwise trigger an immediate quality switch
  // to the fullscreen resolution, causing a rebuffer just as the video expands.
  // Restore auto-ABR after a few seconds once the transition has settled.
  if (hls && hls.currentLevel >= 0) {
    const lockedLevel = hls.currentLevel;
    hls.currentLevel = lockedLevel;
    setTimeout(() => { if (hls) hls.currentLevel = -1; }, 4000);
  }

  // Prefer container fullscreen over video-element fullscreen on all platforms.
  // On iOS, video.webkitEnterFullscreen() hands off to the system's native
  // player which re-fetches the manifest and restarts buffering. Using the
  // container's requestFullscreen() (supported on iOS 16.4+) keeps the same
  // HTMLVideoElement and MediaSource active throughout.
  const container = vdiv.value as HTMLElement | null;
  if (container?.requestFullscreen) {
    try {
      await container.requestFullscreen();
      return;
    } catch (_) {
      // fall through to video-element / webkit fallbacks
    }
  }

  try {
    if (video.value.requestFullscreen) {
      await video.value.requestFullscreen();
    } else if ((video.value as any).webkitRequestFullscreen) {
      await (video.value as any).webkitRequestFullscreen();
    } else if ((video.value as any).mozRequestFullScreen) {
      await (video.value as any).mozRequestFullScreen();
    } else if ((video.value as any).msRequestFullscreen) {
      await (video.value as any).msRequestFullscreen();
    } else if ((video.value as any).webkitEnterFullscreen) {
      // Last resort: iOS native fullscreen — causes a native-player reload.
      (video.value as any).webkitEnterFullscreen();
    } else if (video.value.paused) {
      video.value.play().catch(() => {});
    }
  } catch (error) {
    console.log('VideoJS: Fullscreen failed:', error);
    if (video.value?.paused) {
      video.value.play().catch(() => {});
    }
  }
}

// Handle fullscreen change
function handleFullscreenChange() {
  const fs = !!(
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    (document as any).mozFullScreenElement ||
    (document as any).msFullscreenElement
  );

  isFullscreenActive.value = fs;

  if (!fs && video.value) {
    video.value.pause();
    applyCurrentFeedMutedState();
    isPlaying.value = false;
  } else if (fs && video.value) {
    // If the video source hasn't been loaded yet, start loading it now and
    // let the manifest/canplay handler trigger play via pendingUserPlayRequest.
    if (isHLS.value && !isHLSInitialized) {
      pendingUserPlayRequest = true;
      isBuffering.value = true;
      showVideoError.value = false;
      setupHLS();
    } else if (isRegularVideo.value && !regularVideoActive.value && isInTweetList.value) {
      regularVideoActive.value = true;
      pendingUserPlayRequest = true;
      nextTick(() => { setupRegularVideo(); video.value?.load(); });
    } else if (video.value.paused) {
      video.value.play().catch(() => {
        video.value!.muted = true;
        video.value!.play().catch(() => {});
      });
    }
  }
}


// Handle video element errors with retry mechanism
async function handleVideoError(e: Event) {
  const videoElement = e.target as HTMLVideoElement;
  if (!videoElement || isRetryingVideo) return;
  
  const error = videoElement.error;
  if (!error) return;
  
  const currentSrc = videoElement.src || '';
  const now = Date.now();
  const isBlobSource = currentSrc.startsWith('blob:');

  // HLS uses blob: media source internally; those URLs can become invalid during teardown/re-attach.
  // Treat that as expected lifecycle behavior and avoid showing a false playback error.
  if (isHLS.value && isBlobSource) {
    const isDetached = !document.contains(videoElement);
    const hlsAttachedToThisElement = !!hls && hls.media === videoElement;
    if (isUnmounting || isDetached || !hlsAttachedToThisElement) {
      console.log('Ignoring expected HLS blob error during cleanup/re-attach:', {
        tweetId: props.tweet?.mid,
        src: currentSrc.substring(0, 100) + '...',
        isUnmounting,
        isDetached,
        hlsAttachedToThisElement
      });
      return;
    }
  }

  // For HLS playback, let hls.js own recovery and fatal handling.
  // Native <video> error recovery (src reset/reload) can re-touch stale blob URLs and
  // trigger noisy ERR_FILE_NOT_FOUND in console.
  if (isHLS.value) {
    console.log('Ignoring native video error for HLS; recovery is handled by hls.js', {
      tweetId: props.tweet?.mid,
      code: error.code,
      src: currentSrc.substring(0, 100) + '...'
    });
    return;
  }
  
  // Prevent handling the same error multiple times in quick succession
  if (lastHandledError && 
      lastHandledError.code === error.code && 
      lastHandledError.src === currentSrc &&
      (now - lastHandledError.timestamp) < ERROR_HANDLING_COOLDOWN) {
    console.log('Skipping duplicate error handling within cooldown period');
    return;
  }
  
  lastHandledError = { code: error.code, src: currentSrc, timestamp: now };
  
  console.log('Video error:', {
    tweetId: props.tweet?.mid,
    fileName: props.media.fileName,
    mediaType: props.media.type,
    code: error.code,
    message: error.message,
    src: currentSrc.substring(0, 100) + '...',
    MEDIA_ERR_ABORTED: error.MEDIA_ERR_ABORTED,
    MEDIA_ERR_NETWORK: error.MEDIA_ERR_NETWORK,
    MEDIA_ERR_DECODE: error.MEDIA_ERR_DECODE,
    MEDIA_ERR_SRC_NOT_SUPPORTED: error.MEDIA_ERR_SRC_NOT_SUPPORTED
  });
  
  // Format/source not supported errors (code 4) - don't retry for HLS, just fail
  if (error.code === error.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    if (isHLS.value) {
      console.error('HLS video format not supported, cannot play');
      showVideoError.value = true;
      isBuffering.value = false;
      return;
    }
    console.log('Video format not supported');
    showVideoError.value = true;
    isBuffering.value = false;
    return;
  }
  
  // Abort errors (code 1) - user or script aborted, don't retry
  if (error.code === error.MEDIA_ERR_ABORTED) {
    console.log('Video loading aborted, not retrying');
    return;
  }
  
  // Network errors (code 2) - retry as these are transient
  if (error.code === error.MEDIA_ERR_NETWORK) {
    if (videoErrorRetryCount < MAX_VIDEO_ERROR_RETRIES) {
      videoErrorRetryCount++;
      console.log(`Network error retry attempt ${videoErrorRetryCount}/${MAX_VIDEO_ERROR_RETRIES}`);
      isRetryingVideo = true;
      
      // Wait before retrying (exponential backoff)
      await new Promise(resolve => setTimeout(resolve, 1000 * videoErrorRetryCount));
      
      // Clear the error and retry
      if (videoElement && videoElement.src === currentSrc) {
        videoElement.src = '';
        await new Promise(resolve => setTimeout(resolve, 100));
        videoElement.src = currentSrc;
        videoElement.load();
        
        // Reset retry flag after a delay
        setTimeout(() => {
          isRetryingVideo = false;
        }, 2000);
      } else {
        isRetryingVideo = false;
      }
    } else {
      console.error('Network error: Max retries reached');
      if (isHLS.value) {
        console.error('HLS video failed after retries, cannot play');
      }
      showVideoError.value = true;
      isBuffering.value = false;
    }
    return;
  }
  
  // Decode errors (code 3) - try retry once, then fallback
  if (error.code === error.MEDIA_ERR_DECODE) {
    if (videoErrorRetryCount < 1) { // Only retry once for decode errors
      videoErrorRetryCount++;
      console.log(`Decode error retry attempt ${videoErrorRetryCount}`);
      isRetryingVideo = true;
      
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      if (videoElement && videoElement.src === currentSrc) {
        videoElement.src = '';
        await new Promise(resolve => setTimeout(resolve, 100));
        videoElement.src = currentSrc;
        videoElement.load();
        
        setTimeout(() => {
          isRetryingVideo = false;
        }, 2000);
      } else {
        isRetryingVideo = false;
      }
    } else {
      console.error('Decode error: Retry failed');
      if (isHLS.value) {
        console.error('HLS video decode failed, cannot play');
      }
      showVideoError.value = true;
      isBuffering.value = false;
    }
    return;
  }
  
  // Unknown error code - log and don't retry
  console.warn('Unknown video error code:', error.code, error.message);
}

// Handle native HLS errors with retry (no longer used but kept for compatibility)
async function handleNativeHLSError(videoElement: HTMLVideoElement, fallbackUrl: string, masterUrl: string, playlistUrl: string) {
  // HLS setup probes both playlists first and falls back from the active setup
  // path; keeping this for compatibility but it should not be called.
  console.error('Native HLS: Both playlists failed, cannot play HLS video');
}

// Handle HLS.js fatal errors with retry
async function handleHLSFatalError(data: any, sourceName: string, currentUrl: string, videoElement: HTMLVideoElement) {
  if (videoErrorRetryCount < MAX_VIDEO_ERROR_RETRIES && hls) {
    videoErrorRetryCount++;
    console.log(`HLS.js fatal error retry attempt ${videoErrorRetryCount}/${MAX_VIDEO_ERROR_RETRIES} for ${sourceName}`);
    
    // Destroy current HLS instance
    cleanupHlsInstance();
    
    // Wait before retrying
    await new Promise(resolve => setTimeout(resolve, 1000 * videoErrorRetryCount));
    
    // Recreate HLS instance and retry
    if (videoElement && !isRetryingVideo) {
      isRetryingVideo = true;
      
      // Get the config based on context
      const hlsConfig = isInTweetList.value ? {
        enableWorker: true,
        lowLatencyMode: false,
        abrEwmaDefaultEstimate: 250000,
        abrBandWidthFactor: 0.8,
        abrBandWidthUpFactor: 0.5,
        abrMaxWithRealBitrate: true,
        startLevel: 0,
        capLevelToPlayerSize: true,
        maxBufferLength: 15,
        maxMaxBufferLength: 300,
        maxBufferSize: 30 * 1000 * 1000,
        maxBufferHole: 0.5,
        enableSoftwareAES: false,
        enableStashBuffer: true,
        stashInitialSize: 384 * 1024,
      } : {
        enableWorker: true,
        lowLatencyMode: true,
        abrEwmaDefaultEstimate: 500000,
        abrBandWidthFactor: 0.95,
        abrBandWidthUpFactor: 0.7,
        abrMaxWithRealBitrate: true,
        startLevel: -1,
        capLevelToPlayerSize: true,
        maxBufferLength: 30,
        maxMaxBufferLength: 600,
        maxBufferSize: 60 * 1000 * 1000,
        maxBufferHole: 0.5,
        enableSoftwareAES: false,
        enableStashBuffer: true,
        stashInitialSize: 384 * 1024,
        enableWebAssembly: true,
        backBufferLength: 90,
      };
      
      // Try alternative URL if available
      const masterUrl = getHLSMasterSource();
      const playlistUrl = getHLSSource();
      const retryUrl = currentUrl === masterUrl ? playlistUrl : masterUrl;
      
      console.log(`HLS.js retry: Using ${retryUrl === masterUrl ? 'master' : 'playlist'} playlist`);
      
      hls = new Hls(hlsConfig);
      hls.loadSource(retryUrl);
      hls.attachMedia(videoElement);
      
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log(`HLS.js retry: ${retryUrl === masterUrl ? 'master' : 'playlist'} playlist loaded successfully`);
        isRetryingVideo = false;
        // Reset media error recovery counter on successful retry
        mediaErrorRecoveryCount = 0;
        lastMediaErrorTime = 0;
        if (isInTweetList.value && isCoordinatorPrimary(videoElement)) {
          pendingUserPlayRequest = false;
          playFeedPrimaryVideo(videoElement);
          return;
        }
        if (props.autoplay || pendingUserPlayRequest) {
          pendingUserPlayRequest = false;
          if (isInTweetList.value) {
            if (!isCoordinatorPrimary(videoElement)) return;
            requestPlay(videoElement);
          }
          videoElement.play().catch(() => {
            showPlayOverlay.value = false;
          });
        }
      });
      
      hls.on(Hls.Events.ERROR, (event, errorData) => {
        if (!errorData.fatal) {
          switch (errorData.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              hls?.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
              hls?.recoverMediaError();
              break;
          }
        } else {
          // Another fatal error - give up
          console.error('HLS.js retry: Another fatal error, cannot play HLS video');
          isRetryingVideo = false;
        }
      });
      
      // Reset retry flag after timeout
      setTimeout(() => {
        isRetryingVideo = false;
      }, 10000);
    }
  } else {
    console.error('HLS.js: Max retries reached, cannot play HLS video');
    cleanupHlsInstance();
  }
}

// Stop video playback and clean up resources
function stopVideo() {
  const currentVideo = video.value;
  hlsSetupToken += 1;
  reportPrimaryHealth(false);
  if (isInTweetList.value) {
    debugVideoLoad('stop and release');
  }
  if (isHLS.value) {
    cleanupHlsInstance();
    if (currentVideo) {
      // load() fully resets the video element, aborting any pending fetches
      // on the now-revoked blob URL that cleanupHlsInstance just cleared.
      currentVideo.load();
    }
    isPlaying.value = false;
  } else if (currentVideo) {
    if (!currentVideo.paused) {
      currentVideo.pause();
      isPlaying.value = false;
    }
    currentVideo.currentTime = 0;
  }

  // Reset flags
  hasTriedSinglePlaylist = false;
  videoErrorRetryCount = 0;
  isRetryingVideo = false;
  lastHandledError = null;
  isHLSInitialized = false;
  pendingUserPlayRequest = false;
  coordinatorAutoplayPending.value = false;
  mediaErrorRecoveryCount = 0;
  lastMediaErrorTime = 0;
  currentPlaylistType = null;
  hasTriedPlaylistFallback = false;
  showVideoError.value = false;
  failedFragments.clear();
}
</script>

<template>
  <div ref="vdiv" hidden class="video-container" :class="{ 'tweet-list': isInTweetList }">
    <div class="video-wrapper" :style="videoWrapperStyle">

      <!-- Video and canvas sit FIRST in DOM so overlay buttons (which follow)
           win in iOS Safari's DOM-order hit-testing and receive their taps. -->
      <div
        class="video-tap-handler"
        @click="handleVideoTap"
        @touchstart="handleTouchStart"
        @touchmove="handleTouchMove"
        @touchend="handleTouchEnd"
      >
        <video
          ref="video"
          class="video"
          :class="{'video-portrait': isPortrait, 'hardware-accelerated': supportsHardwareAcceleration}"
          :autoplay="props.autoplay && !isInTweetList"
          :controls="showControls"
          :controlslist="showControls ? controls : undefined"
          :preload="videoPreload"
          playsinline
          webkit-playsinline
          x5-playsinline
          x5-video-player-type="h5"
          x5-video-player-fullscreen="true"
          @loadedmetadata="checkVideoOrientation"
          @contextmenu="disableRightClick"
        >
            <!-- For regular videos only - HLS videos are handled by HLS.js.
                 In feed, source is deferred until coordinator promotes this video. -->
            <source v-if="shouldRenderRegularSource" :src="getVideoSource()" type="video/mp4" />
          Your browser does not support the video tag.
        </video>
        <canvas
          v-show="hasCoverFrame"
          ref="coverCanvas"
          class="video-cover-frame"
          aria-hidden="true"
        />
      </div>

      <!-- All overlays come AFTER the tap handler in DOM so iOS routes taps correctly. -->

      <!-- Video error overlay -->
      <div v-if="showVideoError" class="video-error-overlay">
        <div class="video-error-content">
          <div class="error-icon">⚠️</div>
          <p class="error-message">Video playback error</p>
          <p class="error-hint">This video format may not be supported in your browser</p>
        </div>
      </div>

      <!-- Autoplay blocked overlay -->
      <div v-if="autoplayBlocked && props.autoplay" class="autoplay-blocked-overlay" @click="handleManualPlay">
        <div class="autoplay-blocked-content">
          <div class="play-button">
            <font-awesome-icon icon="play" />
          </div>
          <p class="autoplay-message">Click to play video</p>
        </div>
      </div>

      <!-- Loading spinner overlay -->
      <div v-if="showBufferingOverlay" class="buffering-overlay">
        <div class="buffering-spinner"></div>
      </div>

      <!-- Centered play button shown whenever video is paused/not playing -->
      <div v-if="canShowPausedOverlays"
           class="play-overlay"
           @click="handlePlayOverlayClick"
           @touchend.prevent="handlePlayOverlayClick">
        <div class="play-overlay-button">
          <svg viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </div>
      </div>

      <!-- Mute / fullscreen shortcut buttons for feed -->
      <button
        v-if="showFeedMuteButton"
        class="feed-mute-button"
        type="button"
        :aria-label="isMuted ? 'Unmute video' : 'Mute video'"
        @click="handleMuteOverlayClick"
        @touchend.prevent="handleMuteOverlayClick"
      >
        <svg v-if="isMuted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <line x1="23" y1="9" x2="17" y2="15"></line>
          <line x1="17" y1="9" x2="23" y2="15"></line>
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
        </svg>
      </button>

      <button
        v-if="showFeedFullscreenButton"
        class="fullscreen-overlay-button"
        type="button"
        aria-label="Enter fullscreen"
        @click="handleFullscreenOverlayClick"
        @touchend.prevent="handleFullscreenOverlayClick"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
        </svg>
      </button>

      <div
        v-if="showFeedTimeRemaining"
        class="feed-video-time-remaining"
        aria-hidden="true"
      >
        {{ timeRemainingText }}
      </div>
    </div>
  </div>
</template>

<style>
.video-container {
  width: 100%;
  max-width: 100%;
  max-height: 80vh;
  display: block;
}

.video-wrapper {
  position: relative;
  width: 100%;
  max-height: 80vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #000;
}

.video-tap-handler {
  position: relative;
  width: 100%;
  height: 100%;
  display: block;
}

.video-cover-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
}

.video {
  max-width: 100%;
  max-height: 80vh;
  width: auto;
  height: auto;
  display: block;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  object-fit: contain;
  object-position: center;
  background-color: #000;
  margin: 0 auto;
}

/*
 * Feed tiles: .media-attachments sets height via aspect-ratio. max-height:80vh on container/wrapper/video
 * caps the player shorter than that cell → solid black band under the video.
 */
.video-container.tweet-list,
.video-container.tweet-list .video-wrapper {
  max-height: none !important;
  height: 100% !important;
}

.video-container.tweet-list .video-wrapper {
  display: block !important;
}

.video-container.tweet-list .video,
.video-container.tweet-list .video.video-portrait {
  max-height: none !important;
  object-fit: cover !important;
  object-position: center !important;
}

.video-container.tweet-list .video.video-portrait {
  width: 100% !important;
  height: 100% !important;
  aspect-ratio: unset !important;
  margin: 0 !important;
}

/* Grid items - force video to fill container */
.grid-item .video-container,
.media-attachments .grid-item .video-container {
  width: 100% !important;
  height: 100% !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  position: relative !important;
  overflow: hidden !important;
  background-color: #000 !important;
}

.grid-item .video-wrapper,
.media-attachments .grid-item .video-wrapper {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  overflow: hidden !important;
  background-color: #000 !important;
}

.grid-item .video,
.media-attachments .grid-item .video {
  position: absolute !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100% !important;
  height: 100% !important;
  object-fit: contain !important;
  object-position: center !important;
  max-width: none !important;
  max-height: none !important;
  min-height: 0 !important;
  aspect-ratio: unset !important;
  display: block !important;
  margin: 0 !important;
  padding: 0 !important;
  vertical-align: middle !important;
  line-height: 0 !important;
}

/* Ensure video controls are accessible on mobile */
.video::-webkit-media-controls {
  z-index: 20;
}

.video::-webkit-media-controls-panel {
  z-index: 20;
}

/* Full-screen video styles */
.fullscreen-video {
  max-width: 100%;
  max-height: 100%;
  width: 100%;
  height: 100%;
}

.fullscreen-video .video {
  max-width: 100%;
  max-height: 100%;
  width: 100%;
  height: 100%;
}

/* Hardware acceleration styles */
.hardware-accelerated {
  transform: translateZ(0);
  backface-visibility: hidden;
  perspective: 1000px;
  will-change: transform;
}

/* Portrait video overrides aspect ratio */
.video-portrait {
  max-height: 100%; /* Fit within container */
  width: 100%; /* Use full width to fill container */
  max-width: 100%;
  object-fit: contain; /* Use contain to show full video without cropping */
  object-position: center; /* Center the video content vertically and horizontally */
  aspect-ratio: auto; /* Let the actual video dimensions define the aspect ratio */
  margin: 0 auto; /* Center horizontally */
}


/* Video error overlay styles */
.video-error-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 25;
  pointer-events: none;
}

.video-error-content {
  text-align: center;
  color: white;
  padding: 20px;
  max-width: 80%;
}

.error-icon {
  font-size: 48px;
  margin-bottom: 12px;
  opacity: 0.9;
}

.error-message {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: #ff6b6b;
}

.error-hint {
  font-size: 13px;
  margin: 0;
  opacity: 0.8;
  color: #ccc;
}

/* Autoplay blocked overlay styles */
.autoplay-blocked-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 20;
  cursor: pointer;
  transition: background-color 0.3s ease;
  /* Prevent overlay from expanding container */
  pointer-events: auto;
}

.autoplay-blocked-overlay:hover {
  background: rgba(0, 0, 0, 0.8);
}

.autoplay-blocked-content {
  text-align: center;
  color: white;
}

.play-button {
  font-size: 48px;
  margin-bottom: 10px;
  opacity: 0.9;
  transition: opacity 0.3s ease;
}

.autoplay-blocked-overlay:hover .play-button {
  opacity: 1;
}

.autoplay-message {
  font-size: 14px;
  margin: 0;
  opacity: 0.8;
  font-weight: 500;
}

/* Buffering spinner overlay */
.buffering-overlay {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  z-index: 20;
  pointer-events: none;
}

.buffering-spinner {
  width: 48px;
  height: 48px;
  border: 4px solid rgba(255, 255, 255, 0.3);
  border-top-color: white;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* Play overlay styles - positioned at top */
.play-overlay {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 15;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  pointer-events: auto;
  touch-action: manipulation;
}

.play-overlay-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  background: rgba(0, 0, 0, 0.65);
  border: 2px solid rgba(255, 255, 255, 0.6);
  border-radius: 50%;
  transition: all 0.2s ease;
}

.play-overlay:hover .play-overlay-button {
  transform: scale(1.1);
  background: rgba(0, 0, 0, 0.85);
}

.play-overlay:active .play-overlay-button {
  transform: scale(0.95);
}

.play-overlay-button svg {
  width: 26px;
  height: 26px;
  margin-left: 3px; /* optical center for play triangle */
}

.feed-mute-button {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.2);
  color: rgba(255, 255, 255, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 16;
  transition: background-color 0.2s ease, transform 0.2s ease, opacity 0.2s ease;
}

.feed-mute-button:hover {
  background: rgba(0, 0, 0, 0.2);
  transform: scale(1.05);
}

.feed-mute-button:active {
  transform: scale(0.95);
}

.feed-mute-button svg {
  width: 18px;
  height: 18px;
}

.fullscreen-overlay-button {
  position: absolute;
  right: 12px;
  bottom: 60px;
  width: 40px;
  height: 40px;
  border: 2px solid rgba(255, 255, 255, 0.6);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 17;
  transition: background-color 0.2s ease, transform 0.2s ease, opacity 0.2s ease;
}

.fullscreen-overlay-button:hover {
  background: rgba(0, 0, 0, 0.85);
  transform: scale(1.05);
}

.fullscreen-overlay-button:active {
  transform: scale(0.95);
}

.fullscreen-overlay-button svg {
  width: 18px;
  height: 18px;
}

.feed-video-time-remaining {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 18;
  pointer-events: none;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: rgba(255, 255, 255, 0.6);
  padding: 6px 8px;
  line-height: 1;
  background: rgba(0, 0, 0, 0.2);
  border: none;
  border-radius: 999px;
}

/* Detail view: the wrapper carries the aspect-ratio (from measured metadata,
 * media.aspectRatio hint, or the 16/9 fallback). The <video> is absolutely
 * positioned so its box always exactly matches the wrapper — no flex
 * centering of an intermediate height:100% child to fight against the
 * aspect-ratio on iOS Safari, and no jumping when the video first paints.
 * object-fit:contain keeps the actual frame letterboxed inside once
 * playback starts; during the loading skeleton the entire wrapper is filled. */
.video-container:not(.tweet-list) .video-wrapper {
  display: block;
  width: 100%;
  height: auto;
}

.video-container:not(.tweet-list) .video-tap-handler {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.video-container:not(.tweet-list) .video {
  position: absolute;
  inset: 0;
  width: 100% !important;
  height: 100% !important;
  max-width: 100% !important;
  max-height: 80vh !important;
  object-fit: contain !important;
  object-position: center !important;
  margin: 0 !important;
}

/* Mobile adjustments - Full-width videos */
@media (max-width: 768px) {
  .video-container {
    margin: 0;
    padding: 0;
    width: 100%;
    max-width: 100%;
  }
  
  .video-wrapper {
    margin: 0;
    padding: 0;
    width: 100%;
  }
  
  .video {
    width: 100%;
    max-width: 100%;
    margin: 0;
  }
  
  .play-overlay-button {
    width: 42px;
    height: 42px;
  }

  .play-overlay-button svg {
    width: 22px;
    height: 22px;
  }
}
</style>
