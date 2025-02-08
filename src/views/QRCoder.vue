<script setup lang="ts">
import { onMounted, ref } from "vue";
import QrcodeVue from 'qrcode.vue';
import type { Level, RenderAs, GradientType, ImageSettings } from 'qrcode.vue';

const props = defineProps({
  url: { type: String, required: true },  // QR data url
  size: { type: Number, required: false, default: 100 },  // QR size in pixels
  logoSize: { type: Number, required: false, default: 20 }, // logo size in pixels
});

const level = ref<Level>('M');
const renderAs = ref<RenderAs>('svg');
const background = ref('#ffffff');
const foreground = ref('#604060');
const margin = ref(0);
const logoUrl = ref(import.meta.env.VITE_APP_LOGO)

const logoSettings = ref<ImageSettings>();
const largeLogoSettings = ref<ImageSettings>();

const gradient = ref(false);
const gradientType = ref<GradientType>('radial');
const gradientStartColor = ref('#6a4b6f');
const gradientEndColor = ref('#000000');

const showModal = ref(false);
const largeQRSize = ref(200)

onMounted(async () => {
  logoSettings.value = {
    src: logoUrl.value,
    width: props.logoSize,
    height: props.logoSize,
    excavate: true,
  };
  largeLogoSettings.value = {
    src: logoUrl.value,
    width: props.logoSize * 2,
    height: props.logoSize * 2,
    excavate: false,
  }
})
</script>

<template>
  <div class="qrcode-container" @click="showModal = true">
    <qrcode-vue
      :value="props.url"
      :size="props.size"
      :level="level"
      :render-as="renderAs"
      :background="background"
      :foreground="foreground"
      :gradient="gradient"
      :gradient-type="gradientType"
      :gradient-start-color="gradientStartColor"
      :gradient-end-color="gradientEndColor"
      :image-settings="logoSettings"
    />
  </div>

  <div v-if="showModal" class="modal" @click="showModal = false">
    <div class="modal-content" @click.stop>
      <qrcode-vue
        :value="props.url"
        :size=largeQRSize
        level="H"
        render-as="svg"
        background="#ffffff"
        foreground="#604060"
        :image-settings="largeLogoSettings"
      />
    </div>
  </div>
</template>

<style scoped>
.qrcode-container {
  position: relative;
  cursor: pointer;
}

.modal {
  position: fixed;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  background-color: rgba(0, 0, 0, 0.5);
  display: flex;
  justify-content: center;
  align-items: center;
}

.modal-content {
  background-color: white;
  padding: 10px;
  width: 220px;
  height: 220px;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.1);
}
</style>