<script setup lang="ts">
// import * as pdfobject from 'pdfobject'
import { onMounted } from 'vue';
const props = defineProps({
    mid : {type: String, required: false},
    type: {type: String, required: false},
})

onMounted(async () => {
    console.log("PDF mounted", props)
})

</script>

<template>
    <object type="application/pdf" :data="props.mid"  style="min-height:100vh;width:100%"></object>
</template>