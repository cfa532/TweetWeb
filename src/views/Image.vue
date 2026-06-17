<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PropType } from 'vue'
import type { MediaLoadState } from '@/composables/useTweetMediaLoadingCoordinator'
import { cacheMediaUrl, getCachedMediaObjectUrl, releaseMediaObjectUrl } from '@/utils/mediaCache'

const props = defineProps({
    media: {type: Object as PropType<MimeiFileType>, required: true },
    title: {type: String, required: false},
    index: {type: Number, required: false},
    mediaLoadState: {type: String as PropType<MediaLoadState>, required: false, default: 'visible'},
})

const isLoaded = ref(false);
const imageElement = ref<HTMLImageElement | null>(null);
const imageSrc = ref('');
const shouldLoad = computed(() => props.mediaLoadState !== 'idle');
let sourceRequestId = 0;

function debugImageLoad(message: string) {
    if (!import.meta.env.DEV) return;
    console.debug(`[MEDIA IMAGE] ${message}`, {
        mediaId: props.media.mid,
        fileName: props.media.fileName,
        state: props.mediaLoadState,
    });
}

function markLoadedIfImageSettled() {
    const img = imageElement.value;
    if (!img) return;
    if (img.complete) {
        isLoaded.value = true;
    }
}

function handleImageSettled() {
    isLoaded.value = true;
    if (imageSrc.value === props.media.mid) {
        void cacheMediaUrl(props.media.mid);
    }
}

async function resolveImageSource() {
    const requestId = ++sourceRequestId;
    const previousSrc = imageSrc.value;

    if (!shouldLoad.value) {
        imageSrc.value = '';
        releaseMediaObjectUrl(previousSrc);
        return;
    }

    isLoaded.value = false;
    const cachedSrc = await getCachedMediaObjectUrl(props.media.mid);
    if (requestId !== sourceRequestId) {
        releaseMediaObjectUrl(cachedSrc);
        return;
    }

    imageSrc.value = cachedSrc || props.media.mid;
    releaseMediaObjectUrl(previousSrc);

    await nextTick();
    markLoadedIfImageSettled();
}

watch(() => props.media.mid, async () => {
    await resolveImageSource();
});

watch(shouldLoad, async (load, wasLoading) => {
    if (!load) {
        if (wasLoading) debugImageLoad('cancel');
        await resolveImageSource();
        return;
    }
    debugImageLoad(props.mediaLoadState === 'visible' ? 'load visible' : 'preload');
    await resolveImageSource();
}, { immediate: true });

onMounted(() => {
    markLoadedIfImageSettled();
});

onBeforeUnmount(() => {
    sourceRequestId += 1;
    releaseMediaObjectUrl(imageSrc.value);
});
</script>

<template>
    <div class="img-wrapper">
        <div v-if="shouldLoad && !isLoaded" class="img-loading-overlay">
            <div class="img-spinner"></div>
        </div>
        <img
            v-if="shouldLoad && imageSrc"
            ref="imageElement"
            :src="imageSrc"
            :loading="props.mediaLoadState === 'visible' ? 'eager' : 'lazy'"
            decoding="async"
            @load="handleImageSettled"
            @error="handleImageSettled"
        />
    </div>
</template>

<style>
.img-wrapper {
    position: relative;
    width: 100%;
    height: 100%;
    display: block;
}

.img-loading-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1;
    pointer-events: none;
}

.img-spinner {
    width: 32px;
    height: 32px;
    border: 3px solid rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: img-spin 0.7s linear infinite;
}

@keyframes img-spin {
    to { transform: rotate(360deg); }
}

.container {
    /* text-align: left; */
    margin: 2px;
    padding: 2px;
    /* float: left; */
    display: inline-block;
    background-color: rgba(0, 0, 0, 0.06); /* Semi-transparent background */
}
/* Default styles for non-grid images */
.container img {
    display: block;
    max-width: 100%;
    max-height: 100%;
    width: auto;
    height: auto;
    object-fit: contain; /* Default for single images */
    object-position: center;
}

/* Grid items - force fill - MUST come after default styles and be more specific */
/* This rule MUST override .container img above */
.media-attachments .grid-item .container img,
.media-attachments .grid-item img,
.grid-item .container img,
.grid-item.container img,
div.media-attachments div.grid-item div.container img {
    position: absolute !important;
    top: 0 !important;
    left: 0 !important;
    right: 0 !important;
    bottom: 0 !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: cover !important;
    object-position: center !important;
    max-height: none !important;
    max-width: none !important;
    display: block !important;
    margin: 0 !important;
    padding: 0 !important;
    vertical-align: middle !important;
    line-height: 0 !important;
}



/* Mobile: Full-width images */
@media (max-width: 767px) {
    .container {
        margin: 0;
        padding: 0;
        width: 100%;
        max-width: 100%;
        display: block;
    }

    .container img {
        max-width: 100%;
        max-height: 100%;
        width: auto;
        height: auto;
        object-fit: contain;
    }
}

/* Full-screen image styles */
.fullscreen-image {
    width: auto !important;
    height: auto !important;
    max-width: 100vw !important;
    max-height: none !important;
    object-fit: unset !important;
    display: block;
}
</style>
