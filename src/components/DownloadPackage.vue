<script setup lang="ts">
import { onMounted } from 'vue'
import { useTweetStore } from '@/stores';
import { useRouter } from "vue-router";
const router = useRouter()

onMounted(async () => {
    await useTweetStore().downloadBlob(import.meta.env.VITE_APP_PKG)
    router.back()
})
</script>