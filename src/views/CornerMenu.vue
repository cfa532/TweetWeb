<script setup lang="ts">
// share menu or other right click items
import { ref } from 'vue'
import { useTweetStore } from '@/stores';
import type { PropType } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
const tweetStore = useTweetStore()
const shareMenu = ref()
const btnDelete = ref()
const props = defineProps({ 
    tweet: {type: Object as PropType<Tweet>, required: false}
})

function showMenu() {
    shareMenu.value.hidden = false
    if (tweetStore.loginUser && tweetStore.loginUser.mid==props.tweet?.authorId) {
        btnDelete.value.hidden = false
    }
    // toggle right menu on and off
    setTimeout(() => {
        window.onclick = function (e: MouseEvent) {
            if (e.target !== shareMenu.value) {
                shareMenu.value.hidden = true
                setTimeout(()=>{
                    window.onclick = null
                }, 100)
            }
        }
    }, 100)
}
function copyLink() {
    console.log(window.location.href);
    const input = document.createElement("input");
    input.style.position = "absolute";
    input.style.opacity = "0";
    input.style.pointerEvents = "none";
    input.value = window.location.href;
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    document.body.removeChild(input);
    shareMenu.value.hidden = true
}

function deleteTweet() {
  if (props.tweet) {
    tweetStore.deleteTweet(props.tweet.mid, props.tweet.authorId)
  }
}
</script>

<template>
<div style=" width:100%; position: relative; text-align: right;">
    <a href="#" @click.stop.prevent="showMenu" class="dot"> &#8226;&#8226;&bull; </a>
    <div ref="shareMenu" class="menu" hidden>
        <div class="item">
            <a href="#" style="text-decoration: none; font-size: smaller;" @click.stop="copyLink">
                <font-awesome-icon icon="copy" style="margin-right: 5px;" /> {{ props.tweet?.mid }}
            </a>
        </div>
        <div ref="btnDelete" class="item" hidden>
            <a href="#" style="text-decoration: none;" @click.stop="deleteTweet">Delete</a>
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
.menu {
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