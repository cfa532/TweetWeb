<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import type { PropType } from 'vue'
import { useLeitherStore } from '@/stores/leitherStore';

const props = defineProps({
    media: {type: Object as PropType<MimeiFileType>, required: true },
    title: {type: String, required: false},
    index: {type: Number, required: false},
})

onMounted(async () => {
});
</script>

<template>
    <div>
        <img :src="props.media.mid"/>
    </div>
</template>

<style>
.container {
    /* text-align: left; */
    margin: 0px;
    padding: 0px;
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
}
</style>