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
}
function hideMenu() {
    if (actionMenu.value)
        actionMenu.value.hidden = true
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
<div style=" width:100%; position: relative; text-align: right;" @mouseenter="showMenu" @mouseleave="hideMenu">
    <a href="#" class="dot"> &#8226;&#8226;&bull; </a>
    <div ref="actionMenu" class="action" hidden>
        <div class="item">
            <a href="#" style="text-decoration: none;" @click.stop.prevent="uploadTweet">{{ $t('common.publish') }}</a>
        </div>
        <div class="item">
            <a href="#" style="text-decoration: none;" @click.stop.prevent="netdisk">{{ $t('userActions.netdisk') }}</a>
        </div>
        <div class="item">
            <a href="#" style="text-decoration: none;" @click.stop.prevent="login">{{ loginAction }}</a>
        </div>
    </div>
</div>
</template>

<style scoped>
.dot {
    font-size: 15px;
    color: #ccd0d4;
    padding: 4px 8px 8px 8px;
    margin-right: 10px;
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
.item:last-child {
    border-bottom: none;
}
</style>
