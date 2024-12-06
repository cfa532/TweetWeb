<script lang="ts" setup>
import { ref } from 'vue';
import { QRCoder } from "@/views"

const props = defineProps({
  url: { type: String, required: true },
  size: { type: Number, required: false, default: 120 },
  logoSize: { type: Number, required: false, default: 30 },
})
</script>

<template>
    <div class="modal-overlay">
      <div class="modal-content" width="200px" height="200px">
        <QRCoder :url="url" :size="size"></QRCoder>
      </div>
    </div>
</template>
   
<style scoped>
  .modal-overlay {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
  }
  
  .modal-content {
    background: white;
    padding: 10px;
    border-radius: 8px;
    position: relative;
  }

</style>

