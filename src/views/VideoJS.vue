<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue';
import type { PropType } from 'vue'
import Hls from 'hls.js';
import { useRouter } from 'vue-router';

const props = defineProps({
  media: { type: Object as PropType<MimeiFileType>, required: true },
  autoplay: { type: Boolean, required: false },
})
const router = useRouter();
const vdiv = ref();
const video = ref();
const isPlaying = ref(false);
const isPortrait = ref(false);
const autoplayBlocked = ref(false);
const showPlayOverlay = ref(!props.autoplay); // Don't show overlay initially if autoplay is enabled
  const isHLS = computed(() => {
    const mediaType = props.media.type?.toLowerCase();
    return mediaType === 'hls_video';
  });

  const isRegularVideo = computed(() => {
    const mediaType = props.media.type?.toLowerCase();
    return mediaType === 'video';
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
let intersectionObserver: IntersectionObserver | null = null;
let videoErrorRetryCount = 0;
const MAX_VIDEO_ERROR_RETRIES = 2;
let isRetryingVideo = false;
let lastHandledError: { code: number; src: string; timestamp: number } | null = null;
const ERROR_HANDLING_COOLDOWN = 3000; // 3 seconds cooldown between handling same error
let isHLSInitialized = false; // Prevent multiple HLS initializations

onMounted(() => {
  vdiv.value.hidden = false;
  
    // Setup video element immediately
    if (video.value && !isHLSInitialized) {
        // Add play/pause event listeners to track state
        video.value.addEventListener('play', () => {
          isPlaying.value = true;
          showPlayOverlay.value = false;
        });
        video.value.addEventListener('pause', () => {
          isPlaying.value = false;
          // Don't show overlay if autoplay is enabled (use native controls)
          if (!props.autoplay) {
            showPlayOverlay.value = true;
          }
        });
        video.value.addEventListener('ended', () => {
          isPlaying.value = false;
          // Don't show overlay if autoplay is enabled (use native controls)
          if (!props.autoplay) {
            showPlayOverlay.value = true;
          }
        });
        
        // Add metadata loaded event listener (only once)
        video.value.addEventListener('loadedmetadata', () => {
          // Metadata loaded successfully - reset retry count
          videoErrorRetryCount = 0;
          isRetryingVideo = false;
          lastHandledError = null;
          if (video.value) {
            console.log('Video metadata loaded, duration:', video.value.duration);
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
        
        // Set up intersection observer for autoplay in tweet list
        if (isInTweetList.value) {
          setupIntersectionObserver();
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
  
  // Clean up intersection observer
  if (intersectionObserver) {
    intersectionObserver.disconnect();
    intersectionObserver = null;
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
  
  // Check if HLS is supported natively
  if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
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
      
      // If playlist also fails, give up
      videoElement.addEventListener('error', () => {
        console.error('Native HLS: Both playlists failed, cannot play HLS video');
      }, { once: true });
    }, { once: true });
  } else if (Hls.isSupported()) {
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
    
    // Try both playlists simultaneously
    let masterHls: Hls | null = null;
    let playlistHls: Hls | null = null;
    let isResolved = false;
    let fallbackTimeout: ReturnType<typeof setTimeout> | null = null;
    
    const cleanupLoser = (loser: Hls | null) => {
      if (loser) {
        try {
          loser.destroy();
        } catch (e) {
          console.log('Error destroying loser HLS instance:', e);
        }
      }
    };
    
    const resolveWinner = (winningUrl: string, sourceName: string) => {
      if (isResolved) return;
      isResolved = true;
      
      // Clear fallback timeout
      if (fallbackTimeout) {
        clearTimeout(fallbackTimeout);
        fallbackTimeout = null;
      }
      
      // Cleanup both temporary instances
      cleanupLoser(masterHls);
      cleanupLoser(playlistHls);
      
      // Create final HLS instance with the winning source
      console.log(`HLS.js: ${sourceName} playlist succeeded first, creating final instance`);
      hls = new Hls(hlsConfig);
      hls.loadSource(winningUrl);
      hls.attachMedia(videoElement);
      
      // Clear timeout when manifest is parsed
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log(`HLS.js: ${sourceName} playlist manifest parsed successfully`);
        // Start playing if autoplay is enabled
        if (props.autoplay) {
          videoElement.play().catch(() => {
            // Autoplay was prevented, user will need to use native controls
            showPlayOverlay.value = false; // Still hide overlay, rely on native controls
          });
        }
      });
      
      // Error handling for the final instance
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
              console.log('Media error, attempting to recover...');
              hls?.recoverMediaError();
              break;
          }
        } else {
          console.log(`HLS fatal error on ${sourceName}, attempting retry...`);
          handleHLSFatalError(data, sourceName, winningUrl, videoElement);
        }
      });
    };
    
    // Try master playlist (without attaching to video yet)
    console.log('HLS.js: Loading master playlist:', masterUrl);
    masterHls = new Hls(hlsConfig);
    
    const masterManifestPromise = new Promise<'master' | 'failed'>((resolve) => {
      masterHls!.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!isResolved) {
          resolveWinner(masterUrl, 'master');
          resolve('master');
        } else {
          resolve('master'); // Already resolved, but signal success
        }
      });
      
      masterHls!.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          if (!isResolved) {
            console.log('Master playlist fatal error:', data);
          }
          resolve('failed'); // Resolve with failure status, don't reject
        } else {
          // Non-fatal errors can recover, wait for manifest
          console.log('Master playlist non-fatal error:', data);
        }
      });
    });
    
    masterHls.loadSource(masterUrl);
    
    // Try playlist simultaneously (without attaching to video yet)
    console.log('HLS.js: Loading playlist:', playlistUrl);
    playlistHls = new Hls(hlsConfig);
    
    const playlistManifestPromise = new Promise<'playlist' | 'failed'>((resolve) => {
      playlistHls!.on(Hls.Events.MANIFEST_PARSED, () => {
        if (!isResolved) {
          resolveWinner(playlistUrl, 'playlist');
          resolve('playlist');
        } else {
          resolve('playlist'); // Already resolved, but signal success
        }
      });
      
      playlistHls!.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          if (!isResolved) {
            console.log('Playlist fatal error:', data);
          }
          resolve('failed'); // Resolve with failure status, don't reject
        } else {
          // Non-fatal errors can recover, wait for manifest
          console.log('Playlist non-fatal error:', data);
        }
      });
    });
    
    playlistHls.loadSource(playlistUrl);
    
    // Race both promises - first one to succeed wins
    Promise.race([masterManifestPromise, playlistManifestPromise]).catch(() => {
      // If race fails, wait for the other one
      if (!isResolved) {
        Promise.allSettled([masterManifestPromise, playlistManifestPromise]).then(() => {
          if (!isResolved) {
            console.error('HLS.js: Both playlists failed');
            cleanupLoser(masterHls);
            cleanupLoser(playlistHls);
            isResolved = true;
          }
        });
      }
    });
  }
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
  // For HLS videos, props.media.mid already contains the full IPFS URL
  // We need to append the playlist filename
  const playlistUrl = props.media.mid + '/playlist.m3u8';
  console.log('Trying playlist.m3u8:', playlistUrl);
  return playlistUrl;
}

function getHLSMasterSource(): string {
  // For HLS videos with multiple resolutions, try master playlist first
  const masterUrl = props.media.mid + '/master.m3u8';
  console.log('Trying master.m3u8:', masterUrl);
  return masterUrl;
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


// Handle video element tap/click for mobile
function handleVideoTap(event: Event) {
  // Open video in fullscreen for both tweet list and detail view
  event.preventDefault();
  event.stopPropagation();
  
  if (video.value) {
    // Stop all other videos on the page before going fullscreen
    const allVideos = document.querySelectorAll('video');
    allVideos.forEach(v => {
      if (v !== video.value && !v.paused) {
        v.pause();
      }
    });
    
    // Controls are already enabled
    
    // Keep unmuted for full audio experience
    video.value.muted = false;
    
    // Try to enter fullscreen
    if (video.value.requestFullscreen) {
      video.value.requestFullscreen();
    } else if (video.value.webkitRequestFullscreen) {
      video.value.webkitRequestFullscreen();
    } else if (video.value.mozRequestFullScreen) {
      video.value.mozRequestFullScreen();
    } else if (video.value.msRequestFullscreen) {
      video.value.msRequestFullscreen();
    }
    
    // Start playing after a short delay to ensure fullscreen is ready
    setTimeout(() => {
      if (video.value) {
        video.value.play().catch(() => {
          // If autoplay fails due to policy, try muted first then unmute
          video.value.muted = true;
          video.value.play().then(() => {
            // Successfully started muted, now unmute
            setTimeout(() => {
              video.value.muted = false;
            }, 100);
          }).catch(() => {
            // Still failed, keep muted
          });
        });
      }
    }, 300);
  }
}

// Handle play overlay click
function handlePlayOverlayClick(event: Event) {
  event.stopPropagation();
  event.preventDefault();
  if (video.value) {
    video.value.play();
    isPlaying.value = true;
    showPlayOverlay.value = false;
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
  }
}

// Set up intersection observer for autoplay in tweet list
function setupIntersectionObserver() {
  if (!video.value || !vdiv.value) return;
  
  // Add click handler to enable autoplay on first user interaction
  const enableAutoplay = () => {
    if (video.value) {
      video.value.muted = true;
      video.value.volume = 0;
      video.value.play().catch(() => {});
    }
    document.removeEventListener('touchstart', enableAutoplay);
    document.removeEventListener('click', enableAutoplay);
  };
  
  document.addEventListener('touchstart', enableAutoplay, { once: true });
  document.addEventListener('click', enableAutoplay, { once: true });
  
  intersectionObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        // Video is visible - start muted autoplay
        if (video.value && video.value.paused) {
          // Ensure video is muted for mobile compatibility
          video.value.muted = true;
          video.value.volume = 0;
          
          // Ensure video is loaded before playing
          if (video.value.readyState >= 1) {
            // Metadata is loaded, can play
            video.value.play().catch(() => {
              // If fails, show play button overlay instead
              showPlayOverlay.value = true;
            });
          } else {
            // Metadata not loaded yet, wait for it
            const onLoadedMetadata = () => {
              if (video.value) {
                video.value.play().catch(() => {
                  showPlayOverlay.value = true;
                });
              }
            };
            video.value.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
            video.value.load(); // Force load if not already loading
          }
        }
      } else {
        // Video is not visible - pause it
        if (video.value && !video.value.paused) {
          video.value.pause();
        }
        // Hide play overlay when not visible
        showPlayOverlay.value = false;
      }
    });
  }, {
    threshold: 0.5, // Video must be 50% visible
    rootMargin: '0px'
  });
  
  intersectionObserver.observe(vdiv.value);
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
}
</script>

<template>
  <div ref="vdiv" hidden class="video-container" :class="{ 'tweet-list': isInTweetList }">
    <div class="video-wrapper">
      
      <!-- Autoplay blocked overlay -->
      <div v-if="autoplayBlocked && props.autoplay" class="autoplay-blocked-overlay" @click="handleManualPlay">
        <div class="autoplay-blocked-content">
          <div class="play-button">
            <font-awesome-icon icon="play" />
          </div>
          <p class="autoplay-message">Click to play video</p>
        </div>
      </div>
      
      <!-- Play overlay for paused videos (mobile-friendly) -->
      <div v-if="!isPlaying && showPlayOverlay && !autoplayBlocked" 
           class="play-overlay" 
           @click="handlePlayOverlayClick"
           @touchend.prevent="handlePlayOverlayClick">
        <div class="play-overlay-button">
          <svg viewBox="0 0 24 24" fill="white">
            <path d="M8 5v14l11-7z"/>
          </svg>
        </div>
      </div>
      
      <video
        ref="video"
        class="video"
        :class="{'video-portrait': isPortrait, 'hardware-accelerated': supportsHardwareAcceleration}"
        :autoplay=props.autoplay
        controls
        :controlslist=controls
        preload="auto"
        playsinline
        webkit-playsinline
        x5-playsinline
        x5-video-player-type="h5"
        x5-video-player-fullscreen="true"
        @loadedmetadata="checkVideoOrientation"
        @contextmenu="disableRightClick"
        @click="handleVideoTap"
        @touchend="handleVideoTap"
      >
          <!-- For regular videos only - HLS videos are handled by HLS.js -->
          <source v-if="isRegularVideo" :src="getVideoSource()" type="video/mp4" />
        Your browser does not support the video tag.
      </video>
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
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.video-wrapper {
  position: relative;
  width: 100%;
  /* This wrapper will size itself based on the video */
  display: flex;
  align-items: center;
  justify-content: center;
  background-color: #000;
}

.video {
  width: 100%;
  max-width: 100%;
  height: auto;
  display: block;
  touch-action: manipulation;
  -webkit-tap-highlight-color: transparent;
  /* Ensure video has minimum dimensions */
  min-height: 200px;
  /* Set default aspect ratio to prevent layout shifts before metadata loads */
  aspect-ratio: 16 / 9;
  object-fit: contain; /* Use 'contain' to maintain aspect ratio and fit within container */
  object-position: center; /* Center the video content within the container */
  background-color: #000;
  /* Center the video */
  margin: 0 auto;
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
  max-height: 80vh; /* Adjust this value as needed */
  width: 100%; /* Use full width to fill container */
  max-width: 100%;
  object-fit: cover; /* Use cover to fill container and center content */
  object-position: center; /* Center the video content vertically and horizontally */
  aspect-ratio: auto; /* Let the actual video dimensions define the aspect ratio */
  margin: 0 auto; /* Center horizontally */
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

/* Play overlay styles - positioned at top */
.play-overlay {
  position: absolute;
  top: 10px;
  left: 10px;
  width: auto;
  height: auto;
  background: transparent;
  display: flex;
  align-items: flex-start;
  justify-content: flex-start;
  z-index: 15;
  cursor: pointer;
  -webkit-tap-highlight-color: transparent;
  pointer-events: auto;
  touch-action: manipulation;
  /* Ensure overlay doesn't affect layout */
  margin: 0;
  padding: 0;
}

.play-overlay-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  background: rgba(0, 0, 0, 0.7);
  border-radius: 50%;
  transition: all 0.3s ease;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.play-overlay:hover .play-overlay-button {
  transform: scale(1.1);
  background: rgba(0, 0, 0, 0.85);
}

.play-overlay:active .play-overlay-button {
  transform: scale(0.95);
}

.play-overlay-button svg {
  width: 24px;
  height: 24px;
}

/* Responsive video in detail view - adapts to screen width */
.video-container:not(.tweet-list) .video {
  width: 100% !important;
  max-width: 100% !important;
  height: auto !important;
  max-height: 100vh !important;
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
    width: 44px;
    height: 44px;
  }
  
  .play-overlay-button svg {
    width: 22px;
    height: 22px;
  }
}
</style>