<script setup lang="ts">
import { onMounted } from 'vue';
import type { PropType } from 'vue'

const props = defineProps({
    media: {type: Object as PropType<MimeiFileType>, required: true },
    title: {type: String, required: false},
    index: {type: Number, required: false},
})
</script>

<template>
    <img :src="props.media.mid"/>
</template>

<style>
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
    /* position:relative; */
    display: block;
    max-width: 100%;
    width: 100%;
    height: auto;
    max-height: 90vh;
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
        width: 100%;
        max-width: 100%;
        object-fit: cover;
    }
}

/* Full-screen image styles */
.fullscreen-image {
    width: 100vw !important;
    height: auto !important;
    max-height: 100vh;
    object-fit: contain;
    object-position: center;
    display: block;
}
</style>