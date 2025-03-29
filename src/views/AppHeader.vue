<script lang="ts" setup>
import { watch, onMounted, ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import { useTweetStore } from "@/stores";
import { QRCoder, UserActions } from '@/views';
import { formatTimeDifference } from '@/lib';

const router = useRouter()
const tweetStore = useTweetStore()
const qrSize = 60
const props = defineProps({
    userId: { type: String, required: false },
})
const userId = computed(() => props.userId)
const avatarUrl = ref(import.meta.env.VITE_APP_LOGO)
const user = ref<User>()

onMounted(async () => {
    if (props.userId) {
        user.value = await tweetStore.getUser(props.userId)
    }
})
watch(userId, async (nv, ov) => {
    if (nv !== ov) {
        if (nv) {
            user.value = await tweetStore.getUser(nv)
            console.log(user.value)
        }
        else {
            user.value = undefined
        }
    }
})
</script>

<template>
    <div class="row mb-1">
        <div class="d-flex justify-content-between">
            <div class="d-flex">
                <div class="avatar me-2 ms-2 mt-1">
                    <img :src="user ? user.avatar : avatarUrl" @click="router.push({ name: 'main' })" alt="Logo"
                        class="rounded-circle" />
                </div>
                <!-- User Info -->
                <div v-if="user" class="user-info flex-grow-1">
                    <!-- Username, Alias, and Time -->
                    <div class="username-alias-time">
                        <span class="username fw-bold">{{ user.name }}</span>
                        <span class="alias text-muted">@{{ user.username }}</span>
                        <span class="time text-muted">
                            - {{ formatTimeDifference(user.timestamp as number) }}
                        </span>
                    </div>

                    <div class="mt-1">
                        <span class="alias text-muted">{{ user.profile }}</span>
                    </div>
                </div>
                <!-- Container for the link when no user -->
                <div v-else class="no-user-container">
                    <a href="http://tweet.fireshare.us">HTTP://tweet.fireshare.us</a>
                </div>
            </div>
            <div class="d-flex align-items-start qr-container">
                <button class="btn btn-link" @click="tweetStore.downloadBlob(tweetStore.installApk)">APP ⬇️</button>
                <div class="qr-code-container">
                    <QRCoder :url="tweetStore.installApk" :size="qrSize" :logoSize=20></QRCoder>
                </div>
            </div>
        </div>
        <!-- Followers and Friends Links -->
        <div v-if="user" class="user-actions">
            <div v-if="user" class="links">
                <a href="#" @click.prevent="router.push(`/followers/${user.mid}`)" class="text-muted">{{
                    user.followersCount }} fans</a>
                <a href="#" @click.prevent="router.push(`/followings/${user.mid}`)" class="text-muted">{{
                    user.followingCount }} following</a>
                <a href="#"  class="text-muted">{{ user.tweetCount }} tweet</a>
            </div>
            <UserActions></UserActions>
        </div>
    </div>
</template>

<style scoped>
.qr-container {
    display: flex;
    align-items: flex-end;
    /* Aligns items to the right */
}

.btn {
    font-size: 0.8rem;
}

.qr-code-container {
    display: flex;
    justify-content: center;
    align-items: center;
}

.d-flex {
    margin: 2px 0px;
    display: flex;
    align-items: stretch;
    /* Changed from center to stretch */
    justify-content: space-between;
    /* Ensures space between elements */
    flex-wrap: nowrap;
    /* Prevents wrapping of the QR code */
    min-height: 60px;
    /* Added height to the parent */
}

.avatar img {
    object-fit: cover;
    width: 60px;
    height: 60px;
    cursor: pointer;
    transition: width 0.3s, height 0.3s;
    /* Smooth transition for size changes */
}

.user-info {
    flex-grow: 1;
    /* Allows the user info to take up remaining space */
    margin-left: 10px;
    /* Adds some space between avatar and user info */
    flex-wrap: wrap;
    /* Allows text to wrap on smaller screens */
}

.username-alias-time {
    display: flex;
    align-items: center;
    gap: 1px;
    flex-wrap: wrap;
    /* Allows text to wrap on smaller screens */
    font-size: 0.95rem;
}

.text-muted {
    font-size: 0.95rem;
}

.user-actions {
    display: flex;
    justify-content: space-between;
    align-items: center;
    width: 100%;
}

.links {
    padding-left: 10px;
    display: flex;
    width: 80%;
    /* Takes 80% of the container width */
}

.links a {
    color: #3d5563;
    text-decoration: none;
    font-size: 0.9rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    padding-right: 10px;
    text-align: left;
}

.links a:hover {
    text-decoration: underline;
}

/* UserActions takes the remaining 20% */
:deep(UserActions) {
    width: 20%;
    flex-shrink: 0;
    text-align: right;
}

/* New styles for the link container */
.no-user-container {
    font-size: smaller;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    /* Align content to the bottom */
    flex-grow: 1;
}

@media (max-width: 600px) {
    .qr-container {
        flex-direction: column;
        /* Changes direction to column on small screens */
        align-items: center;
        /* Centers items horizontally */
    }

    .btn {
        font-size: 0.7rem;
    }

    .avatar img {
        width: 50px;
        height: 50px;
    }

    .user-info {
        line-height: 1.2;
        flex-grow: 1;
        margin-left: 1px;
        /* Adjusts margin for smaller screens */
    }

    .username-alias-time {
        gap: 2px;
        /* Reduces gap for smaller screens */
    }

    .links a {
        font-size: 0.9rem;
        /* Reduces font size for smaller screens */
    }

    .d-flex {
        min-height: 50px;
        /* Adjust height for smaller screens */
    }
}

@media (min-width: 1200px) {
    .avatar img {
        width: 60px;
        height: 60px;
    }

    .user-info {
        margin-left: 1px;
        /* Increases margin for larger screens */
    }

    .d-flex {
        min-height: 60px;
    }
}
</style>