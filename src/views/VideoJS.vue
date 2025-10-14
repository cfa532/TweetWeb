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

onMounted(() => {
  vdiv.value.hidden = false;
  
    // Wait for next tick to ensure video element is created
    setTimeout(() => {
      if (video.value) {
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
        
        // Add metadata loaded event listener
        video.value.addEventListener('loadedmetadata', () => {
          // Metadata loaded successfully
          console.log('Video metadata loaded, duration:', video.value?.duration);
        });
        
        video.value.addEventListener('error', (e) => {
          console.log('Video error:', e);
        });
        
        // Add fullscreen change listeners
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
        document.addEventListener('mozfullscreenchange', handleFullscreenChange);
        document.addEventListener('MSFullscreenChange', handleFullscreenChange);
        
        // Delay source loading for mobile HLS compatibility
        setTimeout(() => {
          if (isHLS.value) {
            setupHLS();
          } else if (isRegularVideo.value) {
            setupRegularVideo();
          }
          
          // Force load metadata for mobile
          if (video.value) {
            video.value.load();
          }
        }, 200);
        
        // Set up intersection observer for autoplay in tweet list
        if (isInTweetList.value) {
          setupIntersectionObserver();
        }
      }
    }, 100);
  
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
  if (!video.value) return;
  
  const videoElement = video.value;
  
      // Enable hardware acceleration if supported
    if (supportsHardwareAcceleration.value) {
      videoElement.style.transform = 'translateZ(0)'; // Force hardware acceleration
      videoElement.style.willChange = 'transform'; // Optimize for animations
    }
  
  // Check if HLS is supported natively
  if (videoElement.canPlayType('application/vnd.apple.mpegurl')) {
    // Use native HLS support - try master playlist first, then fallback to single playlist
    videoElement.src = getHLSMasterSource();
    
    // Add fallback for native HLS
    videoElement.addEventListener('error', () => {
      videoElement.src = getHLSSource();
      
      // Add another error listener for single playlist failure
      videoElement.addEventListener('error', () => {
        fallbackToProgressiveVideo(videoElement);
      }, { once: true });
    });
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
    
    hls = new Hls(hlsConfig);
    
      // Try master playlist first
      hasTriedSinglePlaylist = false;
      console.log('Loading master playlist:', getHLSMasterSource());
      hls.loadSource(getHLSMasterSource());
      hls.attachMedia(videoElement);
      
      // Add timeout fallback in case HLS hangs
      const hlsTimeout = setTimeout(() => {
        if (hls && !hasTriedSinglePlaylist) {
          console.log('Master playlist timeout, falling back to playlist.m3u8');
          hasTriedSinglePlaylist = true;
          hls?.destroy();
          hls = new Hls(hlsConfig);
          
          hls.on(Hls.Events.ERROR, (event, data) => {
            console.log('Playlist.m3u8 timeout error:', data);
            if (data.fatal) {
              console.log('Playlist.m3u8 also failed after timeout');
            }
          });
          
          hls.loadSource(getHLSSource());
          hls.attachMedia(videoElement);
        }
      }, 5000); // 5 second timeout
    
    // Clear timeout when manifest is parsed
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      clearTimeout(hlsTimeout);
      
      // Start playing if autoplay is enabled
      if (props.autoplay) {
        videoElement.play().catch(() => {
          // Autoplay was prevented, user will need to use native controls
          showPlayOverlay.value = false; // Still hide overlay, rely on native controls
        });
      }
    });
    
    // Monitor quality level changes
    // hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
    //   console.log('Quality level switched to:', data.level, 'bitrate:', hls?.levels[data.level]?.bitrate);
    // });
    
    // Monitor buffer events for hardware acceleration
    // hls.on(Hls.Events.BUFFER_APPENDING, () => {
    //   if (supportsHardwareAcceleration.value) {
    //     console.log('[HARDWARE] Buffer appending with hardware acceleration');
    //   }
    // });
    
    hls.on(Hls.Events.ERROR, (event, data) => {
      console.log('HLS Error:', data);
      
      // If master playlist fails, try single playlist
      if (!hasTriedSinglePlaylist && data.fatal && data.type === Hls.ErrorTypes.NETWORK_ERROR && 
          (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR || 
           data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
           data.details === Hls.ErrorDetails.MANIFEST_PARSING_ERROR ||
           (data.response && data.response.code && data.response.code >= 400))) {
        console.log('Master playlist failed, falling back to playlist.m3u8');
        hasTriedSinglePlaylist = true;
        hls?.destroy();
        hls = new Hls(hlsConfig); // Use same config for fallback
        
        hls.on(Hls.Events.ERROR, (event, data) => {
          console.log('Playlist.m3u8 error:', data);
          if (data.fatal) {
            console.log('Playlist.m3u8 also failed');
          }
        });
        
        hls.loadSource(getHLSSource());
        hls.attachMedia(videoElement);
        return;
      }
      
      // If we've already tried single playlist or this is a different error, keep HLS mode
      if (hasTriedSinglePlaylist || data.fatal) {
        console.log('HLS error occurred, but keeping HLS mode for hls_video type');
        return;
      }
      
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
  
  // Set the video source directly
  videoElement.src = getVideoSource();
  
  // Add error handling for regular video
  videoElement.addEventListener('error', (e: Event) => {
    // Silent error handling
  }, { once: true });
  
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
  // Destroy HLS instance
  if (hls) {
    hls.destroy();
    hls = null;
  }
  
  // Remove any existing sources
  while (videoElement.firstChild) {
    videoElement.removeChild(videoElement.firstChild);
  }
  
  // Set the video source to the original URL without extension
  // This will attempt to play the video as a progressive download
  const progressiveUrl = props.media.mid;
  videoElement.src = progressiveUrl;
  
  // Add error handling for progressive video
  videoElement.addEventListener('error', (e) => {
    // Silent error handling
  }, { once: true });
  
  // Add load event to confirm progressive video loaded
  videoElement.addEventListener('loadeddata', () => {
    // Video loaded successfully
  }, { once: true });
  
  // Add canplay event
  videoElement.addEventListener('canplay', () => {
    // Video can start playing
  }, { once: true });
  
  // Try to play the video
  if (props.autoplay) {
    videoElement.play().catch(error => {
      // Silent error handling
    });
  }
}

function togglePlay(event?: Event) {
  // Prevent event bubbling if this is from a click/tap
  if (event) {
    event.stopPropagation();
  }
  
  if (video.value.paused) {
    video.value.play();
    isPlaying.value = true;
  } else {
    video.value.pause();
    isPlaying.value = false;
  }
}

// Handle video element tap/click for mobile
function handleVideoTap(event: Event) {
  // On mobile in tweet list, open video in fullscreen
  if (isInTweetList.value) {
    event.preventDefault();
    event.stopPropagation();
    
    if (video.value) {
      // Enable controls for fullscreen
      video.value.controls = true;
      
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
    return;
  }
  
  // Don't interfere with native controls in detail view
  // Only handle taps on the video surface itself when paused
  const target = event.target as HTMLVideoElement;
  if (target.tagName === 'VIDEO' && video.value?.paused) {
    // Only prevent default and handle manually if video is paused
    // This allows native controls to work when video is playing
    event.stopPropagation();
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
  const isFullscreen = !!(document.fullscreenElement || 
                         document.webkitFullscreenElement || 
                         document.mozFullScreenElement || 
                         document.msFullscreenElement);
  
  if (!isFullscreen && video.value) {
    // Exited fullscreen - stop the video and hide controls
    video.value.pause();
    video.value.controls = !isInTweetList.value; // Restore original controls state
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
              video.value.removeEventListener('loadedmetadata', onLoadedMetadata);
              video.value.play().catch(() => {
                showPlayOverlay.value = true;
              });
            };
            video.value.addEventListener('loadedmetadata', onLoadedMetadata);
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
}
</script>

<template>
  <div ref="vdiv" hidden class="video-container">
    <div class="video-wrapper">
      <div v-if="isPortrait" class="custom-controls">
        <button @click.stop="togglePlay">
          <font-awesome-icon :icon='isPlaying ? "pause" : "play"' />
        </button>
        <!-- Add more custom control buttons as needed -->
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
        :controls="!isInTweetList"
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
  object-fit: cover; /* Change from 'contain' to 'cover' to fill container and hide black bars */
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

.custom-controls {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  display: flex;
  justify-content: flex-start;
  background: rgba(0, 0, 0, 0.2);
  color: white;
  padding: 5px;
  z-index: 10;
}

.custom-controls button {
  background: none;
  border: none;
  color: white;
  font-size: 16px;
  cursor: pointer;
  margin-right: 10px;
}

.custom-controls button:hover {
  text-decoration: underline;
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

/* Mobile adjustments */
@media (max-width: 768px) {
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