<script lang="ts" setup>
import { onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';

const props = defineProps<{ tweet: Tweet; }>();
const router = useRouter()
onMounted(()=>{
})
function openUserPage(userId: string) {
    router.push(`/author/${userId}`)
}
</script>
<template>
    <img :src="tweet.author.avatar" alt="User Avatar" class="rounded-circle me-2"
        @click="openUserPage(tweet.author.mid)">
    <div>
        <h6 class="mb-0">{{ tweet.author.name }}</h6>
        <small class="text-muted">@{{ tweet.author.username }} - {{
            formatTimeDifference(tweet.timestamp as number) }}</small>
    </div>
</template>
<style>
.rounded-circle {
    width: 40px;
    height: 40px;
    cursor: pointer
}
</style>