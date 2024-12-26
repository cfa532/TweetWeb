<script setup lang="ts">
import { computed } from "vue";
import { Image, PDFView, VideoJS } from './index'

const props = defineProps({ 
    mid: {type: String, required: true},
    type: {type: String, required: true},
    addtionalItems: {type: Number, required: false},
});
console.log(props)

const userComponent = computed(() => {
    let p = props.type.toLowerCase()
    if (p.includes("image")) {
        return Image
    } else if (p.includes("pdf")) {
        return PDFView
    } else if (p.includes("video") || p.includes("audio") ) {
        return VideoJS
    } else {
        console.warn("Unknown file type:", p)
        return "<p>Unkonwn file type</P>"
    }
})
</script>

<template>
    <div class="container">
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
