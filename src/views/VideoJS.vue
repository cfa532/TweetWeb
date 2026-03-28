<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { PropType } from 'vue'
import Hls from 'hls.js';
import { useRouter } from 'vue-router';
import { useTweetStore } from '@/stores';
import { registerVideo, unregisterVideo, requestPlay, type PrimaryChangeCallback } from '@/composables/useVideoPlaybackCoordinator';

const props = defineProps({
  media: { type: Object as PropType<MimeiFileType>, required: true },
  autoplay: { type: Boolean, required: false },
  tweet: { type: Object as PropType<Tweet>, required: false },
  mediaList: { type: Array as PropType<MimeiFileType[]>, required: false },
  mediaIndex: { type: Number, required: false },
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
const isBuffering = ref(!isAudio); // Show spinner for video until ready; audio renders naturally
const showVideoError = ref(false); // Show error message when video fails to play
const isMobile = isMobileBrowser(); // cached at setup time

// Pre-size video wrapper using attachment's aspect ratio to avoid black-screen flash
const videoWrapperStyle = computed(() => {
  const ar = props.media.aspectRatio;
  if (ar && ar > 0) return { aspectRatio: String(ar) };
  return {};
});

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
// Show native controls on desktop in detail view, hide elsewhere
const showControls = computed(() => !isMobileBrowser() && !isInTweetList.value)

const canShowPausedOverlays = computed(() => {
  return !showVideoError.value &&
    !(autoplayBlocked.value && props.autoplay) &&
    !isPlaying.value &&
    (!isBuffering.value || isMobile);
});

const controls = computed(()=>{
  return props.media.downloadable==false ? "nodownload" : undefined
})

// Detect if this video is being displayed in a tweet list context
const isInTweetList = computed(() => {
  // Check if we're in a tweet list by looking for tweet list specific elements
  const tweetContainer = vdiv.value?.closest('.tweet-container');
  const isInList = tweetContainer && !tweetContainer.closest('.card-body')?.closest('.comment');
  return isInList;
});

// Hardware acceleration detection
const supportsHardwareAcceleration = computed(() => {
  if (!video.value) return false;
  
  // Check for hardware acceleration support
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  
  if (!gl) return false;
  
  // Check for hardware video decoding support
  const videoElement = video.value;
  
  // Test hardware acceleration by checking if the browser supports it
  const testVideo = document.createElement('video');
  testVideo.style.display = 'none';
  document.body.appendChild(testVideo);
  
  // Check for hardware acceleration hints
  const hasHardwareSupport = (
    'mediaCapabilities' in navigator ||
    'getVideoPlaybackQuality' in videoElement ||
    'webkitVideoPlaybackQuality' in videoElement
  );
  
  document.body.removeChild(testVideo);
  
  return hasHardwareSupport;
});

let hls: Hls | null = null;
let hasTriedSinglePlaylist = false;
let videoErrorRetryCount = 0;
const MAX_VIDEO_ERROR_RETRIES = 2;
let isRetryingVideo = false;
let lastHandledError: { code: number; src: string; timestamp: number } | null = null;
const ERROR_HANDLING_COOLDOWN = 3000; // 3 seconds cooldown between handling same error
let isHLSInitialized = false; // Prevent multiple HLS initializations
let mediaErrorRecoveryCount = 0;
const MAX_MEDIA_ERROR_RECOVERIES = 3;
let lastMediaErrorTime = 0;
const MEDIA_ERROR_COOLDOWN = 2000; // 2 seconds cooldown between media error recoveries
let currentPlaylistType: 'master' | 'playlist' | null = null;
let hasTriedPlaylistFallback = false;
let failedFragments = new Set<string>(); // Track fragments that have failed to avoid infinite loops

onMounted(() => {
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
        });
        video.value.addEventListener('playing', () => {
          isBuffering.value = false; // Video is actually playing now
        });
        video.value.addEventListener('waiting', () => {
          isBuffering.value = true; // Video is buffering
        });
        video.value.addEventListener('canplay', () => {
          isBuffering.value = false;
        });
        video.value.addEventListener('pause', () => {
          isPlaying.value = false;
          isBuffering.value = false;
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
          // This maintains the video container space
          if (video.value) {
            // Ensure video maintains its dimensions
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
          if (video.value) {
            // Capture video dimensions to maintain space after video ends
            const videoHeight = video.value.videoHeight;
            const videoWidth = video.value.videoWidth;
            if (videoHeight > 0 && videoWidth > 0) {
              // Calculate aspect ratio and set min-height based on width
              const aspectRatio = videoHeight / videoWidth;
              const containerWidth = video.value.offsetWidth || video.value.clientWidth;
              if (containerWidth > 0) {
                const calculatedHeight = containerWidth * aspectRatio;
                video.value.style.minHeight = Math.max(calculatedHeight, 200) + 'px';
              }
            }
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
          setupHLS();
        } else if (isRegularVideo.value) {
          setupRegularVideo();
        }
        
        // Register with video playback coordinator for single-video-at-a-time in tweet list
        if (isInTweetList.value) {
          const onPrimaryChange: PrimaryChangeCallback = (isPrimary) => {
            if (!hls) return;
            if (isPrimary) {
              // Resume loading so the active video gets full bandwidth
              hls.startLoad(-1);
            } else {
              // Stop loading fragments to free bandwidth for the primary video
              hls.stopLoad();
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

onUnmounted(() => {
  // Clean up event listeners
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  document.removeEventListener('fullscreenchange', handleFullscreenChange);
  document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
  document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
  document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
  
  // Unregister from video playback coordinator
  if (video.value) {
    unregisterVideo(video.value);
  }
  
  // Stop video and clean up HLS
  stopVideo();
});

function setupHLS() {
  if (!video.value || isHLSInitialized) return;
  isHLSInitialized = true;
  
  const videoElement = video.value;
  
      // Enable hardware acceleration if supported
    if (supportsHardwareAcceleration.value) {
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
    // Simple approach: try master first, then playlist if master fails
    const masterUrl = getHLSMasterSource();
    const playlistUrl = getHLSSource();
    
    console.log('Native HLS: Trying master playlist');
    videoElement.src = masterUrl;
    videoElement.load();
    
    // If master fails, try playlist
    videoElement.addEventListener('error', () => {
      console.log('Native HLS: Master failed, trying playlist');
      videoElement.src = playlistUrl;
      videoElement.load();
      
      // If playlist also fails, fall back to hls.js
      videoElement.addEventListener('error', () => {
        console.log('Native HLS: Both playlists failed, falling back to hls.js');
        // Clean up native attempt
        videoElement.src = '';
        videoElement.load();
        // Use hls.js as fallback
        if (Hls.isSupported()) {
          setupHLSWithJS(videoElement);
        } else {
          console.error('Native HLS failed and hls.js is not supported, cannot play HLS video');
        }
      }, { once: true });
    }, { once: true });
  } else if (Hls.isSupported()) {
    // Use hls.js for all non-Safari browsers or when native HLS is not available
    setupHLSWithJS(videoElement);
  } else {
    console.error('HLS is not supported in this browser');
  }
}

// Setup HLS using hls.js library
function setupHLSWithJS(videoElement: HTMLVideoElement) {
    // Configure HLS.js based on context (list vs detail) with hardware acceleration
    const hlsConfig = isInTweetList.value ? {
      // Low quality settings for tweet list with hardware acceleration
      enableWorker: true,
      lowLatencyMode: false, // Disable low latency for list view
      // Conservative bandwidth settings for list view
      abrEwmaDefaultEstimate: 250000, // 250kbps default bandwidth estimate (lower)
      abrBandWidthFactor: 0.8, // More conservative bandwidth factor
      abrBandWidthUpFactor: 0.5, // Very conservative for bandwidth increases
      abrMaxWithRealBitrate: true,
      // Force lower quality for list view
      startLevel: 1, // Start with second quality level (usually 480p)
      capLevelToPlayerSize: true,
      // Smaller buffer for list view
      maxBufferLength: 15, // Reduced buffer length
      maxMaxBufferLength: 300, // Reduced max buffer
      maxBufferSize: 30 * 1000 * 1000, // 30MB max buffer size (smaller)
      maxBufferHole: 0.5,
      // Hardware acceleration settings
      enableSoftwareAES: false, // Use hardware AES if available
      enableStashBuffer: true, // Enable stash buffer for smoother playback
      stashInitialSize: 384 * 1024, // Initial stash buffer size
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
      if (hls) {
        try {
          hls.destroy();
        } catch (e) {
          console.log('Error destroying existing HLS instance:', e);
        }
        hls = null;
      }
      
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
        // Reset media error recovery counter on successful manifest parse
        mediaErrorRecoveryCount = 0;
        lastMediaErrorTime = 0;
        showVideoError.value = false;
        failedFragments.clear();
        // Start playing if autoplay is enabled
        if (props.autoplay) {
          videoElement.play().catch(() => {
            // Autoplay was prevented, user will need to use native controls
            showPlayOverlay.value = false; // Still hide overlay, rely on native controls
          });
        }
      });
      
      // Error handling for the instance
      hls.on(Hls.Events.ERROR, (event, data) => {
        console.log(`HLS Error (${sourceName}):`, data);

        // For non-fatal errors, try to recover
        if (!data.fatal) {
          switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
              console.log('Network error, attempting to recover...');
              hls?.startLoad();
              break;
            case Hls.ErrorTypes.MEDIA_ERROR:
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
                  if (hls) {
                    try {
                      hls.destroy();
                      hls = null;
                    } catch (e) {
                      console.log('Error destroying HLS instance:', e);
                    }
                  }

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
                  hls.destroy();
                  hls = null;
                }
                // Show error message to user
                showVideoError.value = true;
                isBuffering.value = false;
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
    
    // Try master playlist first
    console.log('HLS.js: Trying master playlist first:', masterUrl);
    const testMasterHls = new Hls(hlsConfig);
    
    const masterManifestPromise = new Promise<'master' | 'failed'>((resolve) => {
      testMasterHls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('HLS.js: Master playlist loaded successfully');
        // Clean up test instance
        try {
          testMasterHls.destroy();
        } catch (e) {
          console.log('Error destroying test master HLS instance:', e);
        }
        // Create final instance with master
        createHLSInstance(masterUrl, 'master');
        resolve('master');
      });
      
      testMasterHls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.log('Master playlist fatal error:', data);
          // Clean up test instance
          try {
            testMasterHls.destroy();
          } catch (e) {
            console.log('Error destroying test master HLS instance:', e);
          }
          resolve('failed');
        } else {
          // Non-fatal errors can recover, wait for manifest
          console.log('Master playlist non-fatal error:', data);
        }
      });
    });
    
    testMasterHls.loadSource(masterUrl);
    
    // If master fails, try playlist
    masterManifestPromise.then((result) => {
      if (result === 'failed') {
        console.log('HLS.js: Master playlist failed, trying playlist:', playlistUrl);
        const testPlaylistHls = new Hls(hlsConfig);
        
        const playlistManifestPromise = new Promise<'playlist' | 'failed'>((resolve) => {
          testPlaylistHls.on(Hls.Events.MANIFEST_PARSED, () => {
            console.log('HLS.js: Playlist loaded successfully');
            // Clean up test instance
            try {
              testPlaylistHls.destroy();
            } catch (e) {
              console.log('Error destroying test playlist HLS instance:', e);
            }
            // Create final instance with playlist
            createHLSInstance(playlistUrl, 'playlist');
            resolve('playlist');
          });
          
          testPlaylistHls.on(Hls.Events.ERROR, (event, data) => {
            if (data.fatal) {
              console.log('Playlist fatal error:', data);
              // Clean up test instance
              try {
                testPlaylistHls.destroy();
              } catch (e) {
                console.log('Error destroying test playlist HLS instance:', e);
              }
              console.error('HLS.js: Both master and playlist failed, cannot play HLS video');
              resolve('failed');
            } else {
              // Non-fatal errors can recover, wait for manifest
              console.log('Playlist non-fatal error:', data);
            }
          });
        });
        
        testPlaylistHls.loadSource(playlistUrl);
      }
    });
}

// Setup regular video playback (non-HLS)
function setupRegularVideo() {
  if (!video.value) return;
  
  const videoElement = video.value;
  
  // Enable hardware acceleration if supported
  if (supportsHardwareAcceleration.value) {
    videoElement.style.transform = 'translateZ(0)'; // Force hardware acceleration
    videoElement.style.willChange = 'transform'; // Optimize for animations
  }
  
  // Source is already set via the <source> element in template
  // No need to set src here to avoid conflicts
  
  // Add error handling for regular video
  videoElement.addEventListener('error', handleVideoError);
  
  // Add load event to confirm video loaded
  videoElement.addEventListener('loadeddata', () => {
    // Video loaded successfully
  }, { once: true });
  
  // Add canplay event and start playing if autoplay is enabled
  videoElement.addEventListener('canplay', () => {
    // Video can start playing
    if (props.autoplay) {
      videoElement.play().catch(() => {
        // Autoplay was prevented, user will need to use native controls
        showPlayOverlay.value = false; // Still hide overlay, rely on native controls
      });
    }
  }, { once: true });
  
  // Try to play immediately if autoplay is enabled
  if (props.autoplay) {
    videoElement.play().catch(() => {
      // Will retry when canplay event fires
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
  // Get the base media URL (full URL)
  const baseUrl = getBaseMediaUrl();
  // Append the playlist filename
  const playlistUrl = baseUrl + '/playlist.m3u8';
  console.log('Trying playlist.m3u8:', playlistUrl);
  return playlistUrl;
}

function getHLSMasterSource(): string {
  // Get the base media URL (full URL)
  const baseUrl = getBaseMediaUrl();
  // Append the master playlist filename
  const masterUrl = baseUrl + '/master.m3u8';
  console.log('Trying master.m3u8:', masterUrl);
  return masterUrl;
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
      if (props.autoplay) {
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

function handleFullscreenOverlayClick(event: Event) {
  event.stopPropagation();
  event.preventDefault();
  requestFullscreen();
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
      return;
    }
    console.log('Video format not supported');
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
    try {
      hls.destroy();
      hls = null;
    } catch (e) {
      console.log('Error destroying HLS instance:', e);
    }
    
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
        startLevel: 1,
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
        if (props.autoplay) {
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
    if (hls) {
      try {
        hls.destroy();
        hls = null;
      } catch (e) {
        console.log('Error destroying HLS instance:', e);
      }
    }
  }
}

// Stop video playback and clean up resources
function stopVideo() {
  if (video.value) {
    // Pause the video
    if (!video.value.paused) {
      video.value.pause();
      isPlaying.value = false;
    }

    // Reset video to beginning
    video.value.currentTime = 0;
  }

  // Clean up HLS instance
  if (hls) {
    hls.destroy();
    hls = null;
  }

  // Reset flags
  hasTriedSinglePlaylist = false;
  videoErrorRetryCount = 0;
  isRetryingVideo = false;
  lastHandledError = null;
  isHLSInitialized = false;
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
      
      <!-- Loading spinner overlay: always on desktop; on mobile only after user has started playback -->
      <div v-if="isBuffering && !showControls && (!isMobile || isPlaying)" class="buffering-overlay">
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
        v-if="isInTweetList && canShowPausedOverlays"
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
          :autoplay=props.autoplay
          :controls="showControls"
          :controlslist="showControls ? controls : undefined"
          preload="auto"
          playsinline
          webkit-playsinline
          x5-playsinline
          x5-video-player-type="h5"
          x5-video-player-fullscreen="true"
          @loadedmetadata="checkVideoOrientation"
          @contextmenu="disableRightClick"
        >
            <!-- For regular videos only - HLS videos are handled by HLS.js -->
            <source v-if="isRegularVideo" :src="getVideoSource()" type="video/mp4" />
          Your browser does not support the video tag.
        </video>
      </div>
    </div>
    <p class="video-filename">
      {{ media.fileName }}
    </p>
  </div>
</template>

<style>
.video-container {
  width: 100%;
  max-width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
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

/* Hide filename in grid context */
.grid-item .video-filename,
.media-attachments .grid-item .video-filename {
  display: none !important;
  margin: 0 !important;
  padding: 0 !important;
  height: 0 !important;
  visibility: hidden !important;
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

.video-filename {
  margin-top: 5px;
  font-size: small;
  color: darkslategray;
  padding-left: 1%;
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

.fullscreen-overlay-button {
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

/* Desktop: keep fullscreen button hidden until hover/focus */
@media (hover: hover) and (pointer: fine) {
  .fullscreen-overlay-button {
    opacity: 0;
    pointer-events: none;
  }

  .video-wrapper:hover .fullscreen-overlay-button,
  .fullscreen-overlay-button:focus-visible {
    opacity: 1;
    pointer-events: auto;
  }
}

/* Responsive video in detail view - adapts to screen width and height */
.video-container:not(.tweet-list) .video {
  max-width: 100% !important;
  max-height: 80vh !important;
  width: auto !important;
  height: auto !important;
  object-fit: contain !important;
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