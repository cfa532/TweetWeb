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
.container img {
    /* position:relative; */
    display: block;
    max-width: 100%;
    width: 100%;
    height: auto;
    max-height: 90vh;
    object-fit: contain; /* Add this line to maintain aspect ratio */
}
</style>