<script setup lang="ts">
// share menu or other right click items
import { ref, nextTick } from 'vue'
import { useTweetStore } from '@/stores';
import type { PropType } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
const tweetStore = useTweetStore()
const shareMenu = ref()
const btnDelete = ref()
const props = defineProps({ 
    tweet: {type: Object as PropType<Tweet>, required: false},
    parentTweet: {type: Object as PropType<Tweet>, required: false},
    isComment: {type: Boolean, required: false, default: false}
})

function showMenu() {
    shareMenu.value.hidden = false
    
    // Show delete button if:
    // 1. User is the tweet/comment author, OR
    // 2. It's a comment and user is the parent tweet author
    if (tweetStore.loginUser && props.tweet) {
        const isTweetAuthor = tweetStore.loginUser.mid === props.tweet.authorId
        const isParentTweetAuthor = props.isComment && props.parentTweet && tweetStore.loginUser.mid === props.parentTweet.authorId
        
        if (isTweetAuthor || isParentTweetAuthor) {
            btnDelete.value.hidden = false
        }
    }
    
    // toggle right menu on and off
    setTimeout(() => {
        window.onclick = function (e: MouseEvent) {
            // Don't interfere with video player interactions
            const target = e.target as HTMLElement;
            if (target && (target.tagName === 'VIDEO' || target.closest('video') ||
                          target.classList.contains('video-js') || target.closest('.video-js'))) {
                return; // Let video player handle this click
            }

            if (shareMenu.value && !shareMenu.value.contains(e.target as Node)) {
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

async function deleteItem() {
  if (!props.tweet || !tweetStore.loginUser) {
    shareMenu.value.hidden = true
    return
  }
  
  // Close the menu immediately
  shareMenu.value.hidden = true
  
  if (props.isComment && props.parentTweet) {
    // Delete comment - requires comment author OR parent tweet author
    if (tweetStore.loginUser.mid === props.tweet.authorId || tweetStore.loginUser.mid === props.parentTweet.authorId) {
      const commentIdToDelete = props.tweet.mid
      
      await tweetStore.deleteComment(
        commentIdToDelete,
        props.tweet.authorId,
        props.parentTweet.mid,
        props.parentTweet.authorId
      )
      
      // Force update by replacing the comments array to trigger Vue reactivity
      if (props.parentTweet.comments && Array.isArray(props.parentTweet.comments)) {
        // Remove the comment from the array
        props.parentTweet.comments = props.parentTweet.comments.filter((c: Tweet) => c && c.mid !== commentIdToDelete)
        
        // Update comment count if it exists
        if (props.parentTweet.commentCount !== undefined) {
          props.parentTweet.commentCount = Math.max(0, (props.parentTweet.commentCount || 0) - 1)
        }
        
        // Force Vue to update by using nextTick
        await nextTick()
      }
    }
  } else {
    // Delete regular tweet - requires tweet author
    if (tweetStore.loginUser.mid === props.tweet.authorId) {
      tweetStore.deleteTweet(props.tweet.mid, props.tweet.authorId)
    }
  }
}
</script>

<template>
<div style=" width:100%; position: relative; text-align: right;">
    <a href="#" @click.stop.prevent="showMenu" class="dot"> &#8226;&#8226;&bull; </a>
    <div ref="shareMenu" class="menu" hidden>
        <div class="item copy-item" @click.stop="copyLink" style="cursor: pointer;">
            <span style="text-decoration: none; font-size: smaller;">
                <font-awesome-icon icon="copy" style="margin-right: 5px;" /> {{ props.tweet?.mid }}
            </span>
        </div>
        <div ref="btnDelete" class="item clickable-item" @click.stop="deleteItem" hidden style="cursor: pointer;">
            <span style="text-decoration: none;">Delete</span>
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
.clickable-item:hover {
    background-color: #e0e0e0;
    transition: background-color 0.2s ease;
}
.copy-item:hover {
    background-color: #e0e0e0;
    transition: background-color 0.2s ease;
}
</style>