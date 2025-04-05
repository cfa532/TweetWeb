<script setup lang="ts">
import { computed } from "vue";
import type { PropType } from 'vue'
import { Image, PDFView, VideoJS, BlobData } from './index'

const props = defineProps({ 
    media: {type: Object as PropType<MimeiFileType>, required: true },
    tweet: {type: Object as PropType<Tweet>, required: false},
    autoplay: {type: Boolean, required: false},
    addtionalItems: {type: Number, required: false},    // show PLUS sign over last item in preview grid
});
const mediaMid = computed(() => {
    return props.media.mid.substring(props.media.mid.lastIndexOf("/")+1)
})
const userComponent = computed(() => {
    let p = props.media.type.toLowerCase()
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
</script>

<template>
    <div class="container" :id="mediaMid">
        <span v-if="addtionalItems" class="overlay">+{{ addtionalItems }}</span>
        <KeepAlive>
            <component :is="userComponent" v-bind="props"></component>
        </KeepAlive>
    </div>
</template>


<style>
.overlay {
    z-index: 9999;
    position: absolute;
    top: 0;
    left: 0;
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
}
</style>
