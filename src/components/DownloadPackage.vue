<script setup lang="ts">
import { onMounted } from 'vue'
import { useTweetStore } from '@/stores';
import { useRouter } from "vue-router";
const router = useRouter()

onMounted(async () => {
    await useTweetStore().downloadApk()
    router.back()
})
</script>