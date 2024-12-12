<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useTweetStore } from '@/stores'
import { useRoute } from 'vue-router';
import { AppHeader, UserRow } from "@/views";

const route = useRoute();
const userId = route.params.userId as MimeiId
const tweetStore = useTweetStore()
const following = ref([] as User[])
const isLoading = ref(false)
const user = ref<User>()

onMounted(async () => {
    isLoading.value = true
    let ids = await tweetStore.getFollowings(userId)
    user.value = await tweetStore.getUser(userId)
    isLoading.value = false
    ids.forEach(async (mid :MimeiId) => {
        let user = await tweetStore.getUser(mid)
        if (user) {
            following.value.push(user)
        }
    });
})
</script>
<template>
    <AppHeader v-if="user" :user="user"/>
    <UserRow v-for="user in following" :user="user" :key="user.mid" class="user-row" />
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