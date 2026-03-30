<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import type { PropType } from 'vue';
import { Image, VideoJS } from '@/views';

const props = defineProps({
  mediaList: { type: Array as PropType<MimeiFileType[]>, required: false },
  initialIndex: { type: Number, required: false },
  tweet: { type: Object as PropType<Tweet>, required: false }
});

const router = useRouter();

// Get data from session storage if not provided as props
const mediaViewerData = ref<any>(null);
const currentIndex = ref(0);

onMounted(() => {
  // Try to get data from session storage
  const storedData = sessionStorage.getItem('mediaViewerData');
  if (storedData) {
    try {
      mediaViewerData.value = JSON.parse(storedData);
      const originalIndex = mediaViewerData.value.initialIndex || 0;
      const originalMediaList = mediaViewerData.value.mediaList || [];
      
      // Wait for computed values to be ready
      nextTick(() => {
        // Find the media at the original index
        const targetMedia = originalMediaList[originalIndex];
        
        // Find the index of this media in the filtered list
        if (targetMedia) {
          const filteredIndex = mediaItems.value.findIndex(
            (media: MimeiFileType) => media.mid === targetMedia.mid
          );
          currentIndex.value = filteredIndex >= 0 ? filteredIndex : 0;
        } else {
          currentIndex.value = 0;
        }
        
        // Debug logging
        console.log('MediaViewer data:', mediaViewerData.value);
        console.log('Original index:', originalIndex);
        console.log('Filtered index:', currentIndex.value);
        console.log('Media items:', mediaItems.value);
        console.log('Current media:', currentMedia.value);
      });
    } catch (error) {
      console.error('Failed to parse media viewer data:', error);
      router.back();
      return;
    }
  } else if (!props.mediaList) {
    // No data available, go back
    console.error('No media viewer data available');
    router.back();
    return;
  }
  
  isVisible.value = true;
  document.body.style.overflow = 'hidden';
  document.addEventListener('keydown', handleKeydown);
});
const isVisible = ref(false);
const containerRef = ref<HTMLElement>();
const startX = ref(0);
const startY = ref(0);
const currentX = ref(0);
const currentY = ref(0);
const isDragging = ref(false);
const dragThreshold = 50; // Minimum distance to trigger swipe
const isClosing = ref(false);

// Get media list from props or session storage
const mediaList = computed(() => props.mediaList || mediaViewerData.value?.mediaList || []);
const tweet = computed(() => props.tweet || mediaViewerData.value?.tweet);

// Filter media to include images and videos
const mediaItems = computed(() => 
  mediaList.value.filter((media: MimeiFileType) => {
    const type = media.type?.toLowerCase() || '';
    return type.includes('image') || type.includes('video') || type.includes('hls_video');
  })
);

const currentMedia = computed(() => mediaItems.value[currentIndex.value]);
const isImage = computed(() => currentMedia.value?.type?.toLowerCase().includes('image'));
const isVideo = computed(() => {
  const type = currentMedia.value?.type?.toLowerCase() || '';
  return type.includes('video') || type.includes('hls_video');
});

const currentMediaIndex = computed(() => currentIndex.value);


onUnmounted(() => {
  document.body.style.overflow = '';
  document.removeEventListener('keydown', handleKeydown);
});

watch(() => props.initialIndex, (newIndex) => {
  if (newIndex !== undefined) {
    currentIndex.value = newIndex;
  }
});

function handleKeydown(event: KeyboardEvent) {
  switch (event.key) {
    case 'Escape':
      closeModal();
      break;
    case 'ArrowLeft':
      previousMedia();
      break;
    case 'ArrowRight':
      nextMedia();
      break;
  }
}

function closeModal() {
  isClosing.value = true;
  // Clean up session storage
  sessionStorage.removeItem('mediaViewerData');
  setTimeout(() => {
    router.back();
  }, 200);
}

function nextMedia() {
  if (currentIndex.value < mediaItems.value.length - 1) {
    currentIndex.value = currentIndex.value + 1;
  }
}

function previousMedia() {
  if (currentIndex.value > 0) {
    currentIndex.value = currentIndex.value - 1;
  }
}

function handleTouchStart(event: TouchEvent) {
  if (event.touches.length === 1) {
    startX.value = event.touches[0].clientX;
    startY.value = event.touches[0].clientY;
    isDragging.value = true;
  }
}

function handleTouchMove(event: TouchEvent) {
  if (!isDragging.value || event.touches.length !== 1) return;
  
  currentX.value = event.touches[0].clientX;
  currentY.value = event.touches[0].clientY;
  
  // Prevent default to avoid scrolling
  event.preventDefault();
}

function handleTouchEnd(event: TouchEvent) {
  if (!isDragging.value) return;
  
  const deltaX = currentX.value - startX.value;
  const deltaY = currentY.value - startY.value;
  
  // Check if it's a horizontal swipe (more horizontal than vertical movement)
  if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > dragThreshold) {
    if (deltaX > 0) {
      // Swipe right - go to previous media
      previousMedia();
    } else {
      // Swipe left - go to next media
      nextMedia();
    }
  }
  
  isDragging.value = false;
}

function handleMouseDown(event: MouseEvent) {
  startX.value = event.clientX;
  startY.value = event.clientY;
  isDragging.value = true;
}

function handleMouseMove(event: MouseEvent) {
  if (!isDragging.value) return;
  
  currentX.value = event.clientX;
  currentY.value = event.clientY;
}

function handleMouseUp(event: MouseEvent) {
  if (!isDragging.value) return;
  
  const deltaX = currentX.value - startX.value;
  const deltaY = currentY.value - startY.value;
  
  // Check if it's a horizontal drag (more horizontal than vertical movement)
  if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > dragThreshold) {
    if (deltaX > 0) {
      // Drag right - go to previous media
      previousMedia();
    } else {
      // Drag left - go to next media
      nextMedia();
    }
  }
  
  isDragging.value = false;
}

function goToMedia(index: number) {
  if (index >= 0 && index < mediaItems.value.length) {
    currentIndex.value = index;
  }
}
</script>

<template>
  <div 
    class="media-viewer-modal"
    :class="{ 'closing': isClosing }"
    @click="closeModal"
    @touchstart="handleTouchStart"
    @touchmove="handleTouchMove"
    @touchend="handleTouchEnd"
    @mousedown="handleMouseDown"
    @mousemove="handleMouseMove"
    @mouseup="handleMouseUp"
    @mouseleave="isDragging = false"
  >
    <div class="media-viewer-content" @click.stop>
      <!-- Close button -->
      <button class="close-button" @click="closeModal" aria-label="Close">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>

      <!-- Navigation arrows -->
      <button 
        v-if="currentMediaIndex > 0"
        class="nav-button nav-button-left" 
        @click="previousMedia"
        aria-label="Previous media"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="15,18 9,12 15,6"></polyline>
        </svg>
      </button>

      <button 
        v-if="currentMediaIndex < mediaItems.length - 1"
        class="nav-button nav-button-right" 
        @click="nextMedia"
        aria-label="Next media"
      >
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="9,18 15,12 9,6"></polyline>
        </svg>
      </button>

      <!-- Media container -->
      <div class="media-container" ref="containerRef">
        <div v-if="currentMedia && isImage" class="image-container">
          <Image 
            :media="currentMedia" 
            :tweet="tweet"
            class="fullscreen-image"
          />
        </div>
        <div v-else-if="currentMedia && isVideo" class="video-container">
          <VideoJS 
            :media="currentMedia" 
            :tweet="tweet"
            :autoplay="true"
          />
        </div>
        <div v-else class="no-media">
          <p>No media to display</p>
        </div>
      </div>

      <!-- Media counter -->
      <div v-if="mediaItems.length > 1" class="media-counter">
        {{ currentMediaIndex + 1 }} / {{ mediaItems.length }}
      </div>

      <!-- Thumbnail navigation -->
      <div v-if="mediaItems.length > 1" class="thumbnail-nav">
        <div 
          v-for="(media, index) in mediaItems" 
          :key="media.mid"
          class="thumbnail"
          :class="{ 'active': index === currentMediaIndex }"
          @click="goToMedia(index)"
        >
          <img 
            v-if="media.type?.toLowerCase().includes('image')"
            :src="media.mid" 
            :alt="`Thumbnail ${index + 1}`"
          />
          <div 
            v-else
            class="thumbnail-video"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="white">
              <path d="M8 5v14l11-7z"/>
            </svg>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.media-viewer-modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.95);
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 1;
  transition: opacity 0.2s ease;
}

.media-viewer-modal.closing {
  opacity: 0;
}

.media-viewer-content {
  position: relative;
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  box-sizing: border-box;
}

.close-button {
  position: fixed;
  top: 20px;
  right: 20px;
  background: rgba(0, 0, 0, 0.8);
  border: none;
  color: white;
  width: 50px;
  height: 50px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 1001;
  transition: all 0.2s ease;
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.close-button:hover {
  background: rgba(0, 0, 0, 0.7);
}

.nav-button {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  background: rgba(0, 0, 0, 0.8);
  border: none;
  color: white;
  width: 60px;
  height: 60px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  z-index: 1001;
  transition: all 0.2s ease;
  backdrop-filter: blur(10px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.nav-button:hover {
  background: rgba(0, 0, 0, 0.9);
}

.nav-button-left {
  left: 20px;
}

.nav-button-right {
  right: 20px;
}

.media-container {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  margin: 0;
}

.image-container,
.video-container {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
  overflow: hidden;
}

.fullscreen-image {
  width: auto !important;
  height: auto !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  object-fit: contain;
  object-position: center;
  display: block;
}

.image-container :deep(.img-wrapper) {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
}

.image-container :deep(.img-wrapper img) {
  width: auto !important;
  height: auto !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
  object-fit: contain !important;
  object-position: center !important;
}

.video-container :deep(.video-container) {
  width: 100vw !important;
  height: 100vh !important;
  max-width: 100vw !important;
  max-height: 100vh !important;
}

.video-container :deep(.video) {
  width: 100vw !important;
  height: auto !important;
  max-height: 100vh !important;
  object-fit: contain !important;
}

.no-media {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: white;
  font-size: 18px;
}

.media-counter {
  position: fixed;
  bottom: 100px;
  left: 50%;
  transform: translateX(-50%);
  background: rgba(0, 0, 0, 0.8);
  color: white;
  padding: 10px 20px;
  border-radius: 25px;
  font-size: 16px;
  font-weight: 500;
  z-index: 1000;
  backdrop-filter: blur(10px);
}

.thumbnail-nav {
  position: fixed;
  bottom: 30px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  gap: 8px;
  background: rgba(0, 0, 0, 0.8);
  padding: 10px;
  border-radius: 15px;
  max-width: 90vw;
  overflow-x: auto;
  z-index: 1000;
  backdrop-filter: blur(10px);
}

.thumbnail {
  width: 60px;
  height: 60px;
  border-radius: 8px;
  overflow: hidden;
  cursor: pointer;
  border: 2px solid transparent;
  transition: border-color 0.2s ease;
  flex-shrink: 0;
}

.thumbnail.active {
  border-color: #007bff;
}

.thumbnail img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumbnail-video {
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
}

/* Mobile optimizations */
@media (max-width: 768px) {
  .media-viewer-content {
    padding: 0;
  }
  
  .close-button {
    width: 45px;
    height: 45px;
    top: 15px;
    right: 15px;
  }
  
  .nav-button {
    width: 50px;
    height: 50px;
  }
  
  .nav-button-left {
    left: 15px;
  }
  
  .nav-button-right {
    right: 15px;
  }
  
  .media-counter {
    bottom: 80px;
    font-size: 14px;
    padding: 8px 16px;
  }
  
  .thumbnail-nav {
    bottom: 20px;
    padding: 8px;
  }
  
  .thumbnail {
    width: 50px;
    height: 50px;
  }
}

/* Touch device optimizations */
@media (hover: none) and (pointer: coarse) {
  .close-button:hover,
  .nav-button:hover {
    background: rgba(0, 0, 0, 0.5);
  }
}
</style>
