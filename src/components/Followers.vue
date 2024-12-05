<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useTweetStore } from '@/stores'
import { useRoute } from 'vue-router';
import { ItemHeader, AppHeader, UserRow } from "@/views";

const route = useRoute();
const userId = route.params.userId as MimeiId
const tweetStore = useTweetStore()
const followers = ref([] as User[])
const isLoading = ref(false)

onMounted(async () => {
    isLoading.value = true
    let ids = await tweetStore.getFollowers(userId)
    isLoading.value = false
    ids.forEach(async (mid :MimeiId) => {
        let user = await tweetStore.getUser(mid)
        if (user) {
            // await tweetStore.getFollowCount(user)
            followers.value.push(user)
        }
    });
})
</script>
<template>
    <AppHeader />
    <UserRow v-for="user in followers" :user="user" :key="user.mid" class="user-row" />
    <div v-if="isLoading" class="d-flex justify-content-center my-3">
        <div class="spinner-border" role="status">
            <span class="visually-hidden">Loading...</span>
        </div>
    </div>
</template>

<style scoped>
.user-row {
    border: 1px solid #ccc; /* Adds a light gray border */
    border-radius: 5px; /* Rounds the corners slightly */
    margin: 5px 5px; /* Adds vertical space between rows */
    padding: 10px; /* Adds space inside the border */
    background-color: #f9f9f9; /* Light background color for contrast */
    transition: background-color 0.3s ease; /* Smooth transition for hover effect */
}

.user-row:hover {
    background-color: #e9e9e9; /* Slightly darker background on hover */
}
</style>