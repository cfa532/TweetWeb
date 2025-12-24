<script setup lang="ts">
import { computed } from "vue";
import type { PropType } from 'vue'
import { useRouter } from 'vue-router';
import { Image, PDFView, VideoJS, BlobData } from './index'

const props = defineProps({ 
    media: {type: Object as PropType<MimeiFileType>, required: true },
    tweet: {type: Object as PropType<Tweet>, required: false},
    autoplay: {type: Boolean, required: false},
    addtionalItems: {type: Number, required: false},    // show PLUS sign over last item in preview grid
    mediaList: {type: Array as PropType<MimeiFileType[]>, required: false}, // All media items for gallery
    mediaIndex: {type: Number, required: false}, // Index of current media in the list
});

const router = useRouter();

const mediaMid = computed(() => {
    return props.media.mid.substring(props.media.mid.lastIndexOf("/")+1)
})

const userComponent = computed(() => {
    let p = props.media.type?.toLowerCase() || ''
    if (p.includes("image")) {
        return Image
    } else if (p.includes("pdf")) {
        return PDFView
    } else if (p.includes("video") || p.includes("audio") ) {
        return VideoJS
    } else {
        return BlobData
    }
})

const isMediaViewable = computed(() => {
    const mediaType = props.media.type?.toLowerCase() || '';
    return mediaType.includes("image") || mediaType.includes("video") || mediaType.includes("hls_video");
});

function handleMediaClick(event: MouseEvent) {
    const mediaType = props.media.type?.toLowerCase() || '';
    
    // For images, always open media viewer
    if (mediaType.includes("image")) {
        // Prevent the tweet click event from firing
        event.stopPropagation();
        
        // Get all media items from the tweet
        const allMedia = props.mediaList || (props.tweet?.attachments || []);
        
        // Filter to only images and find the current image's index within the filtered list
        const imageMedia = allMedia.filter(media => media.type?.toLowerCase().includes('image'));
        const currentImageIndex = imageMedia.findIndex(media => media.mid === props.media.mid);
        
        // Store media data in session storage for the modal
        sessionStorage.setItem('mediaViewerData', JSON.stringify({
            mediaList: allMedia,
            initialIndex: currentImageIndex,
            tweet: props.tweet
        }));
        
        // Navigate to media viewer
        router.push('/media-viewer');
    }
    // For videos, the click is handled by VideoJS component
    // MediaView just needs to allow the click to pass through
}
</script>

<template>
    <div 
        class="container" 
        :id="mediaMid"
        :class="{ 'clickable-media': isMediaViewable }"
        @click="handleMediaClick"
    >
        <span v-if="addtionalItems" class="overlay">+{{ addtionalItems }}</span>
        <KeepAlive>
            <component :is="userComponent" v-bind="props"></component>
        </KeepAlive>
    </div>
</template>


<style>
.container {
    position: relative;
    width: 100%;
    height: 100%;
    display: block;
    overflow: hidden;
    background-color: #000;
}

/* In grid context, ensure container fills completely */
.grid-item .container {
    width: 100% !important;
    height: 100% !important;
    display: block !important;
    margin: 0 !important;
    padding: 0 !important;
}

.clickable-media {
    cursor: pointer;
    transition: transform 0.2s ease, opacity 0.2s ease;
}

.clickable-media:hover {
    transform: scale(1.02);
    opacity: 0.9;
}

.overlay {
    z-index: 9999;
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5); /* Semi-transparent background */
    display: flex;
    justify-content: center;
    align-items: center;
    color: white;
    font-size: 48px;
    font-weight: bold;
    pointer-events: none; /* Ensures the overlay doesn't interfere with clicks */
    margin: 0;
    padding: 0;
}

/* Ensure overlay is centered in grid items */
.grid-item .overlay,
.media-attachments .grid-item .overlay {
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    width: 100% !important;
    height: 100% !important;
    display: flex !important;
    justify-content: center !important;
    align-items: center !important;
    text-align: center !important;
    line-height: 1 !important;
}
</style>
