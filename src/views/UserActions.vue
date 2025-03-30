<script setup lang="ts">
// share menu or other right click items
import { onMounted, ref } from 'vue'
import { useTweetStore } from '@/stores';
import { useRouter } from 'vue-router';

const router = useRouter();
const tweetStore = useTweetStore()
const actionMenu = ref()
const loginAction = ref("Login")

onMounted(() => {
    if (tweetStore.loginUser) {
        loginAction.value = "Logout"
    } else {
        loginAction.value = "Login"
    }
})

function showMenu() {
    actionMenu.value.hidden = false

    // toggle right menu on and off
    setTimeout(() => {
        window.onclick = function (e: MouseEvent) {
            if (e.target !== actionMenu.value) {
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
        loginAction.value = "Login"
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
            <a href="#" style="text-decoration: none;" @click.stop="login">{{ loginAction }}</a>
        </div>
        <div class="item">
            <a href="#" style="text-decoration: none;" @click.stop="uploadTweet">Publish</a>
        </div>
        <div class="item">
            <a href="#" style="text-decoration: none;" @click.stop="netdisk">Netdisk</a>
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
