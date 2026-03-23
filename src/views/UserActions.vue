<script setup lang="ts">
// share menu or other right click items
import { onMounted, ref } from 'vue'
import { useTweetStore } from '@/stores';
import { useRouter } from 'vue-router';
import { useI18n } from 'vue-i18n';

const router = useRouter();
const tweetStore = useTweetStore()
const { t } = useI18n()
const actionMenu = ref()
const loginAction = ref(t('auth.login'))

onMounted(() => {
    if (tweetStore.loginUser) {
        loginAction.value = t('auth.logout')
    } else {
        loginAction.value = t('auth.login')
    }
})

function showMenu() {
    actionMenu.value.hidden = false

    // toggle right menu on and off
    setTimeout(() => {
        window.onclick = function (e: MouseEvent) {
            // Don't interfere with video player interactions
            const target = e.target as HTMLElement;
            if (target && (target.tagName === 'VIDEO' || target.closest('video') ||
                          target.classList.contains('video-js') || target.closest('.video-js'))) {
                return; // Let video player handle this click
            }

            if (e.target !== actionMenu.value) {
                if (actionMenu.value)
                    actionMenu.value.hidden = true
                setTimeout(()=>{
                    window.onclick = null
                }, 100)
            }
        }
    }, 100)
}
function netdisk() {
    actionMenu.value.hidden = true
    router.push({name: 'netdisk'})
}
function uploadTweet() {
    actionMenu.value.hidden = true
    router.push({name: 'post'})
}
function login() {
    if (tweetStore.loginUser) {
        tweetStore.logout()
        sessionStorage.setItem("isBot", "No")
        loginAction.value = t('auth.login')
        location.reload()
    } else {
        router.push({name: 'login'})
    }
    actionMenu.value.hidden = true
}
</script>

<template>
<div style=" width:100%; position: relative; text-align: right;">
    <a href="#" @click.stop.prevent="showMenu" class="dot"> &#8226;&#8226;&bull; </a>
    <div ref="actionMenu" class="action" hidden>
        <div class="item">
            <a href="#" style="text-decoration: none;" @click.stop="uploadTweet">{{ $t('common.publish') }}</a>
        </div>
        <div class="item">
            <a href="#" style="text-decoration: none;" @click.stop="netdisk">{{ $t('userActions.netdisk') }}</a>
        </div>
        <div class="item">
            <a href="#" style="text-decoration: none;" @click.stop="login">{{ loginAction }}</a>
        </div>
    </div>
</div>
</template>

<style scoped>
.dot {
    font-size: 15px;
    color: grey;
    padding: 4px 10px 8px 10px;
    text-decoration: none;
}
.action {
    position: absolute;
    top: 5px;
    right: 0px;
    z-index: 20;
    background-color: whitesmoke;
    box-shadow: 0 4px 8px 0 rgba(0, 0, 0, 0.2), 0 6px 20px 0 rgba(0, 0, 0, 0.19);
    width: 250px;
}
.item {
    border-bottom: 1px dotted;
    padding: 10px;
    text-align: center;
}
</style>
