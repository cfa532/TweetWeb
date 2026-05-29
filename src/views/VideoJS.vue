<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch, nextTick, inject } from 'vue';
import type { PropType } from 'vue'
import Hls from 'hls.js';
import { useRouter } from 'vue-router';
import { useTweetStore } from '@/stores';
import { registerVideo, unregisterVideo, requestPlay, isCoordinatorPrimary, type PrimaryChangeCallback } from '@/composables/useVideoPlaybackCoordinator';
import type { MediaLoadState } from '@/composables/useTweetMediaLoadingCoordinator';

// Cross-instance HLS playlist cache, keyed by base media URL. The same
// stream may be opened by multiple VideoJS instances (e.g. once in the
// feed and once in the tweet detail view) on different copies of the
// media object — the per-prop cache (props.media.playlist) doesn't survive
// the JSON.parse round trip from sessionStorage. Caching globally lets the
// detail view skip the parallel master.m3u8 + playlist.m3u8 probe and go
// straight to whichever filename the feed already validated. Avoids
// re-issuing the playlist.m3u8 request that often returns 500.
const globalPlaylistFilenameCache = new Map<string, 'master.m3u8' | 'playlist.m3u8'>();

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

// Show native controls on desktop detail view AFTER metadata loads.
const showControls = computed(() => !isMobileBrowser() && !isInTweetList.value && hasMetadata.value)

const canShowPausedOverlays = computed(() => {
  return !showVideoError.value &&
    !(autoplayBlocked.value && props.autoplay) &&
    !isPlaying.value &&
    !coordinatorAutoplayPending.value &&
    (!isBuffering.value || isMobile);
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
const isMuted = ref(false);

const isSoleMediaInGrid = computed(() => {
  if (!props.mediaList || props.mediaList.length === 0) return true;
  return props.mediaList.length === 1;
});

const showFeedTimeRemaining = computed(
  () =>
    isInTweetList.value &&
    isSoleMediaInGrid.value &&
    isPlaying.value &&
    !isAudio &&
    !showVideoError.value,
);

const showFeedMuteButton = computed(
  () =>
    isInTweetList.value &&
    !isAudio &&
    !showVideoError.value,
);

function syncMutedState() {
  if (!video.value) return;
  isMuted.value = video.value.muted;
}

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
  syncMutedState();
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
let currentPlaylistType: 'master' | 'playlist' | null = null;
let hasTriedPlaylistFallback = false;
let failedFragments = new Set<string>(); // Track fragments that have failed to avoid infinite loops
const MANIFEST_PROBE_TIMEOUT_MS = 12000;
let pendingUserPlayRequest = false;
let hlsSetupToken = 0;

function shouldLoadFeedMedia(): boolean {
  if (!isInTweetList.value) return true;
  return props.mediaLoadState !== 'idle';
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

function releaseFeedMedia(reason: string) {
  debugVideoLoad(reason);
  hlsSetupToken += 1;
  regularVideoActive.value = false;
  cleanupHlsInstance();
  isHLSInitialized = false;
  isPlaying.value = false;
  isBuffering.value = false;
  coordinatorAutoplayPending.value = false;
  hasMetadata.value = false;
  showVideoError.value = false;
  nextTick(() => {
    const el = video.value;
    if (!el) return;
    try {
      if (!el.paused) el.pause();
      el.removeAttribute('src');
      el.load();
    } catch {}
  });
}

onMounted(() => {
  isUnmounting = false;
  vdiv.value.hidden = false;
  
    // Setup video element immediately
    if (video.value && !isHLSInitialized) {
        // Clear initial spinner if video is already in a playable state (e.g. from cache)
        if (video.value.readyState >= 3) {
          isBuffering.value = false;
        }

        // Add play/pause event listeners to track state
        video.value.addEventListener('play', () => {
          isPlaying.value = true;
          showPlayOverlay.value = false;
          isBuffering.value = true; // Show spinner when play starts, hide when actually playing
          updateTimeRemaining();
        });
        video.value.addEventListener('playing', () => {
          isBuffering.value = false;
          coordinatorAutoplayPending.value = false;
          updateTimeRemaining();
          syncMutedState();
        });
        video.value.addEventListener('timeupdate', updateTimeRemaining);
        video.value.addEventListener('volumechange', syncMutedState);
        video.value.addEventListener('waiting', () => {
          isBuffering.value = true; // Video is buffering
        });
        video.value.addEventListener('canplay', () => {
          if (!coordinatorAutoplayPending.value) {
            isBuffering.value = false;
          }
        });
        video.value.addEventListener('pause', () => {
          isPlaying.value = false;
          isBuffering.value = false;
          coordinatorAutoplayPending.value = false;
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
              if (hls) hls.startLoad(-1);
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

  if (isHLS.value && !isHLSInitialized) {
    isBuffering.value = state === 'visible';
    debugVideoLoad(state === 'visible' ? 'load visible hls' : 'preload hls');
    setupHLS();
    return;
  }

  if (isRegularVideo.value && !regularVideoActive.value) {
    regularVideoActive.value = true;
    isBuffering.value = state === 'visible';
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
      console.log('Native HLS: Trying master playlist');
      cacheResolvedPlaylistFilename('master.m3u8');
      videoElement.src = masterUrl;
      videoElement.load();

      videoElement.addEventListener('error', () => {
        console.log('Native HLS: Master failed, trying playlist');
        cacheResolvedPlaylistFilename('playlist.m3u8');
        videoElement.src = playlistUrl;
        videoElement.load();

        videoElement.addEventListener('error', () => {
          console.log('Native HLS: Both playlists failed, falling back to hls.js');
          videoElement.src = '';
          videoElement.load();
          if (Hls.isSupported()) {
            setupHLSWithJS(videoElement, setupToken);
          } else {
            console.error('Native HLS failed and hls.js is not supported, cannot play HLS video');
          }
        }, { once: true });
      }, { once: true });
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

// Setup HLS using hls.js library
function setupHLSWithJS(videoElement: HTMLVideoElement, setupToken: number) {
    // Configure HLS.js based on context (list vs detail) with hardware acceleration
    const hlsConfig = isInTweetList.value ? {
      // Low quality settings for tweet list with hardware acceleration
      enableWorker: true,
      lowLatencyMode: false, // Disable low latency for list view
      // Start modestly, but keep enough buffer for smooth primary playback.
      abrEwmaDefaultEstimate: 500000,
      abrBandWidthFactor: 0.9,
      abrBandWidthUpFactor: 0.65,
      abrMaxWithRealBitrate: true,
      // Start with the lowest quality for list view (safe for single-level streams)
      startLevel: 0,
      capLevelToPlayerSize: true,
      maxBufferLength: 30,
      maxMaxBufferLength: 180,
      maxBufferSize: 60 * 1000 * 1000,
      maxBufferHole: 0.5,
      // Hardware acceleration settings
      enableSoftwareAES: false, // Use hardware AES if available
      enableStashBuffer: true, // Enable stash buffer for smoother playback
      stashInitialSize: 768 * 1024,
    } : {
      // High quality settings for detail view with hardware acceleration
      enableWorker: true,
      lowLatencyMode: true,
      // Auto quality selection settings
      abrEwmaDefaultEstimate: 500000, // 500kbps default bandwidth estimate
      abrBandWidthFactor: 0.95, // Conservative bandwidth factor
      abrBandWidthUpFactor: 0.7, // More conservative for bandwidth increases
      abrMaxWithRealBitrate: true, // Use real bitrate for ABR decisions
      // Quality selection preferences
      startLevel: -1, // Auto-select starting quality level
      capLevelToPlayerSize: true, // Cap quality to player size
      // Buffer settings for smooth playback
      maxBufferLength: 30, // Max buffer length in seconds
      maxMaxBufferLength: 600, // Absolute max buffer length
      maxBufferSize: 60 * 1000 * 1000, // 60MB max buffer size
      maxBufferHole: 0.5, // Max buffer hole in seconds
      // Hardware acceleration settings
      enableSoftwareAES: false, // Use hardware AES if available
      enableStashBuffer: true, // Enable stash buffer for smoother playback
      stashInitialSize: 384 * 1024, // Initial stash buffer size
      // Advanced hardware acceleration
      enableWebAssembly: true, // Enable WebAssembly for better performance
      backBufferLength: 90, // Back buffer length for smooth seeking
    };
    
    const masterUrl = getHLSMasterSource();
    const playlistUrl = getHLSSource();
    
    // Helper function to create and attach HLS instance
    const createHLSInstance = (url: string, sourceName: string) => {
      // Clean up any existing HLS instance
      cleanupHlsInstance();
      
      // Create new HLS instance
      console.log(`HLS.js: Creating instance with ${sourceName} playlist`);
      hls = new Hls(hlsConfig);
      hls.loadSource(url);
      hls.attachMedia(videoElement);
      
      // Handle manifest parsed
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log(`HLS.js: ${sourceName} playlist manifest parsed successfully`);
        // Track which playlist type we're using
        currentPlaylistType = sourceName as 'master' | 'playlist';
        cacheResolvedPlaylistFilename(sourceName === 'master' ? 'master.m3u8' : 'playlist.m3u8');
        // Reset media error recovery counter on successful manifest parse
        mediaErrorRecoveryCount = 0;
        lastMediaErrorTime = 0;
        showVideoError.value = false;
        if (!coordinatorAutoplayPending.value) {
          isBuffering.value = false;
        }
        failedFragments.clear();
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
      
      // Error handling for the instance
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.log(`HLS Error (${sourceName}):`, data);

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

                // Check if we've already tried to recover this fragment
                if (failedFragments.has(fragUrl)) {
                  console.log(`Fragment ${fragUrl} has already failed - skipping without recovery`);
                  return; // Don't recover same fragment multiple times
                }

                // Mark this fragment as failed and attempt recovery once
                failedFragments.add(fragUrl);
                console.log(`Fragment parsing error for ${fragUrl} - attempting recovery (attempt 1)`);
                hls?.recoverMediaError();
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
    
    const probeManifest = (url: string, sourceName: 'master' | 'playlist') => {
      let probeHls: Hls | null = new Hls(hlsConfig);
      let settled = false;
      let timeoutId: number;

      const cancel = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        try { probeHls?.destroy(); } catch {}
        probeHls = null;
      };

      const promise = new Promise<boolean>((resolve) => {
        const finish = (ok: boolean) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeoutId);
          try { probeHls?.destroy(); } catch {}
          probeHls = null;
          resolve(ok);
        };

        timeoutId = window.setTimeout(() => finish(false), MANIFEST_PROBE_TIMEOUT_MS);

        probeHls!.on(Hls.Events.MANIFEST_PARSED, () => {
          console.log(`HLS.js: ${sourceName} playlist loaded successfully`);
          cacheResolvedPlaylistFilename(sourceName === 'master' ? 'master.m3u8' : 'playlist.m3u8');
          finish(true);
        });

        probeHls!.on(Hls.Events.ERROR, (_event, data) => {
          if (data.fatal) finish(false);
        });

        probeHls!.loadSource(url);
      });

      return { promise, cancel };
    };

    const cachedFilename = getCachedPlaylistFilename();
    if (cachedFilename) {
      const cachedUrl = cachedFilename === 'master.m3u8' ? masterUrl : playlistUrl;
      const sourceName = cachedFilename === 'master.m3u8' ? 'master' : 'playlist';
      console.log(`HLS.js: Using cached playlist ${cachedFilename}`);
      createHLSInstance(cachedUrl, sourceName);
    } else {
      // Probe both playlists in parallel — first success wins, loser is cancelled
      (async () => {
        if (isUnmounting) return;

        const masterProbe = probeManifest(masterUrl, 'master');
        const playlistProbe = probeManifest(playlistUrl, 'playlist');

        try {
          const winner = await Promise.any([
            masterProbe.promise.then(ok => {
              if (!ok) throw new Error('master probe failed');
              playlistProbe.cancel();
              return { url: masterUrl, sourceName: 'master' as const };
            }),
            playlistProbe.promise.then(ok => {
              if (!ok) throw new Error('playlist probe failed');
              masterProbe.cancel();
              return { url: playlistUrl, sourceName: 'playlist' as const };
            }),
          ]);

          if (isUnmounting) return;
          if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;
          createHLSInstance(winner.url, winner.sourceName);
        } catch {
          if (isUnmounting) return;
          if (setupToken !== hlsSetupToken || !shouldLoadFeedMedia()) return;
          console.warn('HLS.js: Both manifest probes failed; falling back to direct attach with master');
          createHLSInstance(masterUrl, 'master');
        }
      })();
    }
}

// Setup regular video playback (non-HLS)
function setupRegularVideo() {
  if (!video.value) return;

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
    isBuffering.value = false;
  }, { once: true });

  // Add canplay event and start playing if autoplay is enabled
  videoElement.addEventListener('canplay', () => {
    isBuffering.value = false;
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

function getCachedPlaylistFilename(): 'master.m3u8' | 'playlist.m3u8' | null {
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

function cacheResolvedPlaylistFilename(fileName: 'master.m3u8' | 'playlist.m3u8') {
  const baseUrl = getBaseMediaUrl();
  globalPlaylistFilenameCache.set(baseUrl, fileName);
  if (props.media.playlist !== fileName) {
    props.media.playlist = fileName;
    console.log(`[HLS Playlist Cache] STORE for media ${props.media.mid}: ${fileName}`);
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
  
  // On mobile, check if touch is on video controls
  if (isMobileBrowser()) {
    console.log('VideoJS: Mobile browser detected, processing tap');

    // Get touch position
    let clickY = 0;
    const videoHeight = video.value.offsetHeight || video.value.clientHeight;

    if (mouseEvent instanceof TouchEvent) {
      if (mouseEvent.changedTouches && mouseEvent.changedTouches.length > 0) {
        const touch = mouseEvent.changedTouches[0];
        const rect = video.value.getBoundingClientRect();
        clickY = touch.clientY - rect.top;
      }
    } else if (mouseEvent instanceof MouseEvent) {
      const rect = video.value.getBoundingClientRect();
      clickY = mouseEvent.clientY - rect.top;
    }

    // Check if touch is on controls area (bottom 20% for mobile - controls are larger)
    const isOnControls = clickY > videoHeight * 0.8;

    // Check if controls are visible (video is playing or has been interacted with)
    const controlsVisible = !video.value.paused || video.value.currentTime > 0;

    // If touch is directly on video element (not wrapper), it might be on controls
    if (target === video.value || target.closest('video') === video.value) {
      // Check if it's in the controls area
      if (isOnControls) {
        console.log('VideoJS: Touch on video controls, letting native handle');
        return; // Let native controls handle it
      }
    }

    // Request fullscreen when controls are not visible, or when tapping on empty space
    if (!controlsVisible) {
      console.log('VideoJS: Mobile browser - controls not visible, requesting fullscreen');
      event.preventDefault();
      event.stopPropagation();
      requestFullscreen();
      return;
    } else {
      // Controls are visible
      if (isOnControls) {
        console.log('VideoJS: Mobile browser - tapping on controls, letting native handle');
        return; // Let native controls handle it
      } else {
        console.log('VideoJS: Mobile browser - tapping on empty space with controls visible, requesting fullscreen');
        event.preventDefault();
        event.stopPropagation();
        requestFullscreen();
        return;
      }
    }
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
        // Other contexts: request fullscreen
        console.log('VideoJS: Tapping on video area, requesting fullscreen');
        event.preventDefault();
        event.stopPropagation();
        requestFullscreen();
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
      // On mobile, open fullscreen when play button is tapped
      if (isMobileBrowser()) {
        // Start playing before requesting fullscreen
        if (video.value.paused) {
          video.value.play().catch(() => {
            // If play fails, try muted
            video.value.muted = true;
            video.value.play().catch(() => {});
          });
        }
        // Request fullscreen
        requestFullscreen();
        return;
      }

      // Desktop: play inline
      // If video has ended, reset to beginning
      if (video.value.ended || video.value.currentTime >= video.value.duration) {
        video.value.currentTime = 0;
      }

      // Tell coordinator this is now the active video (pauses all others)
      requestPlay(video.value);

      video.value.play().catch(() => {
        video.value.muted = true;
        video.value.play().catch(() => {});
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

  console.log('VideoJS: Requesting fullscreen for video element');

  // For mobile browsers, try multiple approaches
  if (isMobileBrowser()) {
    console.log('VideoJS: Mobile browser detected, trying mobile-specific fullscreen');

    try {
      // Try iOS-specific fullscreen first
      if ((video.value as any).webkitEnterFullscreen) {
        console.log('VideoJS: Using iOS webkitEnterFullscreen()');
        (video.value as any).webkitEnterFullscreen();
        return;
      }

      // Try standard fullscreen API
      if (video.value.requestFullscreen) {
        console.log('VideoJS: Using requestFullscreen()');
        await video.value.requestFullscreen();
        return;
      }

      // Try webkit fullscreen
      if ((video.value as any).webkitRequestFullscreen) {
        console.log('VideoJS: Using webkitRequestFullscreen()');
        (video.value as any).webkitRequestFullscreen();
        return;
      }

      console.log('VideoJS: No mobile fullscreen API available, ensuring video plays');
      // If fullscreen isn't available, at least make sure video plays
      if (video.value.paused) {
        video.value.play().catch((e: any) => console.log('VideoJS: Play failed:', e));
      }

    } catch (error) {
      console.log('VideoJS: Mobile fullscreen failed:', error);
      // Fallback: just play the video
      try {
        if (video.value.paused) {
          video.value.play().catch((e: any) => console.log('VideoJS: Fallback play failed:', e));
        }
      } catch (playError) {
        console.log('VideoJS: All mobile fullscreen attempts failed');
      }
    }
  } else {
    // Desktop fullscreen
    try {
      if (video.value.requestFullscreen) {
        await video.value.requestFullscreen();
      } else if ((video.value as any).webkitRequestFullscreen) {
        await (video.value as any).webkitRequestFullscreen();
      } else if ((video.value as any).mozRequestFullScreen) {
        await (video.value as any).mozRequestFullScreen();
      } else if ((video.value as any).msRequestFullscreen) {
        await (video.value as any).msRequestFullscreen();
      }
    } catch (error) {
      console.log('VideoJS: Desktop fullscreen failed:', error);
    }
  }
}

// Handle fullscreen change
function handleFullscreenChange() {
  const isFullscreen = !!(
    document.fullscreenElement ||
    (document as any).webkitFullscreenElement ||
    (document as any).mozFullScreenElement ||
    (document as any).msFullscreenElement
  );

  if (!isFullscreen && video.value) {
    // Exited fullscreen - stop the video and hide controls
    video.value.pause();
    // Controls remain enabled
    video.value.muted = false; // Restore unmuted state
    isPlaying.value = false;
  } else if (isFullscreen && video.value) {
    // Entered fullscreen - ensure video is playing
    if (video.value.paused) {
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
  // This function is no longer used as we try both playlists simultaneously
  // Keeping for compatibility but it should not be called
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
      
      <!-- Loading spinner overlay: always shown when buffering. Sits on top of
           the native browser controls so the spinner is visible even on Safari
           detail view (where the native loading indicator is barely visible
           against the black wrapper). On mobile, suppress before the user
           starts playback so it doesn't compete with the play overlay. -->
      <div v-if="isBuffering && (!isMobile || isPlaying)" class="buffering-overlay">
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

      <!-- Fullscreen shortcut for tweet feed when video is paused/not playing -->
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
      </div>

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
  background: rgba(0, 0, 0, 0.3);
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
  width: 72px;
  height: 72px;
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
  width: 40px;
  height: 40px;
  margin-left: 4px; /* optical center for play triangle */
}

.feed-mute-button {
  position: absolute;
  right: 12px;
  bottom: 12px;
  width: 40px;
  height: 40px;
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 16;
  transition: background-color 0.2s ease, transform 0.2s ease, opacity 0.2s ease;
}

.feed-mute-button:hover {
  background: rgba(0, 0, 0, 0.85);
  transform: scale(1.05);
}

.feed-mute-button:active {
  transform: scale(0.95);
}

.feed-mute-button svg {
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
  color: #fff;
  padding: 4px 8px;
  line-height: 1;
  background: rgba(0, 0, 0, 0.65);
  border: 1px solid rgba(255, 255, 255, 0.65);
  border-radius: 999px;
}

/* Desktop: keep fullscreen button hidden until hover/focus */
@media (hover: hover) and (pointer: fine) {
  .feed-mute-button {
    opacity: 0;
    pointer-events: none;
  }

  .video-wrapper:hover .feed-mute-button,
  .feed-mute-button:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }
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
    width: 64px;
    height: 64px;
  }

  .play-overlay-button svg {
    width: 36px;
    height: 36px;
  }
}
</style>
