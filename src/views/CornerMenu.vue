<script setup lang="ts">
// share menu or other right click items
import { ref, nextTick, computed } from 'vue'
import { useTweetStore } from '@/stores';
import { useAlertStore } from '@/stores/alert.store';
import { useI18n } from 'vue-i18n';
import type { PropType } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
const tweetStore = useTweetStore()
const alertStore = useAlertStore()
const { t } = useI18n()
const shareMenu = ref()
const dotBtn = ref()
const canDelete = ref(false)
const canEdit = ref(false)
const showEditor = ref(false)
const editContent = ref('')
const props = defineProps({
    tweet: {type: Object as PropType<Tweet>, required: false},
    parentTweet: {type: Object as PropType<Tweet>, required: false},
    isComment: {type: Boolean, required: false, default: false}
})

// Truncate mid with ellipsis in the middle if too long
const displayMid = computed(() => {
  const mid = props.tweet?.mid || ''
  const maxLength = 24
  if (mid.length <= maxLength) return mid
  const start = mid.slice(0, 10)
  const end = mid.slice(-10)
  return `${start}...${end}`
})

function showMenu() {
    // Position menu using fixed positioning to avoid overflow clipping
    const rect = dotBtn.value.getBoundingClientRect()
    shareMenu.value.style.top = rect.bottom + 'px'
    shareMenu.value.style.left = Math.max(0, rect.right - 220) + 'px'
    shareMenu.value.hidden = false

    // Show delete button if:
    // 1. User is the tweet/comment author, OR
    // 2. It's a comment and user is the parent tweet author
    if (tweetStore.loginUser && props.tweet) {
        const isTweetAuthor = tweetStore.loginUser.mid === props.tweet.authorId
        const isParentTweetAuthor = props.isComment && props.parentTweet && tweetStore.loginUser.mid === props.parentTweet.authorId

        if (isTweetAuthor || isParentTweetAuthor) {
            canDelete.value = true
        }
        if (isTweetAuthor) {
            canEdit.value = true
        }
    }
}
function hideMenu() {
    if (shareMenu.value)
        shareMenu.value.hidden = true
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

function openEditor() {
  if (!props.tweet) return
  shareMenu.value.hidden = true
  editContent.value = props.tweet.content || ''
  showEditor.value = true
}

async function submitEdit() {
  if (!props.tweet || !tweetStore.loginUser) return
  try {
    await tweetStore.updateTweet(props.tweet.mid, editContent.value)
    props.tweet.content = editContent.value
    showEditor.value = false
  } catch (error: any) {
    alertStore.error(error.message || t('tweet.failedUpdateTweet'))
  }
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
<div style="width:100%; text-align: right;" @mouseenter="showMenu" @mouseleave="hideMenu">
    <a ref="dotBtn" href="#" class="dot"> &#8226;&#8226;&bull; </a>
    <div ref="shareMenu" class="menu" hidden @mouseenter="showMenu" @mouseleave="hideMenu">
        <div class="item copy-item" @click.stop="copyLink">
            <span class="menu-text">
                <font-awesome-icon icon="copy" style="margin-right: 5px;" /> {{ displayMid }}
            </span>
        </div>
        <div v-if="canEdit" class="item clickable-item" @click.stop="openEditor">
            <span class="menu-text"><font-awesome-icon icon="pen" style="margin-right: 5px;" />{{ $t('common.edit') }}</span>
        </div>
        <div v-if="canDelete" class="item clickable-item" @click.stop="deleteItem">
            <span class="menu-text"><font-awesome-icon icon="trash-can" style="margin-right: 5px;" />{{ $t('common.delete') }}</span>
        </div>
    </div>
</div>

<!-- Edit Modal -->
<div v-if="showEditor" class="edit-overlay" @click.self="showEditor = false">
    <div class="edit-modal" @click.stop>
        <div class="edit-header">
            <span>{{ $t('tweet.editTweet') }}</span>
            <a href="#" @click.prevent="showEditor = false" style="color: grey; text-decoration: none;">&times;</a>
        </div>
        <textarea v-model="editContent" class="edit-textarea" rows="6"></textarea>
        <div class="edit-actions">
            <button class="btn-cancel" @click="showEditor = false">{{ $t('common.cancel') }}</button>
            <button class="btn-submit" @click="submitEdit">{{ $t('common.save') }}</button>
        </div>
    </div>
</div>
</template>

<style scoped>
.dot {
    font-size: 15px;
    color: gray;
    padding: 4px 8px 8px 8px;
    text-decoration: none;
}
.menu {
    position: fixed;
    z-index: 50;
    background: #fff;
    border: 1px solid #e6ecf0;
    border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
    min-width: 220px;
    padding: 0;
    overflow: hidden;
}
.item {
    padding: 10px 12px;
    text-align: left;
    color: #4a4a4a;
    font-size: 0.9rem;
    cursor: pointer;
    border-bottom: 1px solid #eef2f4;
}
.item:last-child {
    border-bottom: none;
}
.menu-text {
    text-decoration: none;
}
.clickable-item:hover {
    background: #f5f8fa;
    transition: background-color 0.2s ease;
}
.copy-item:hover {
    background: #f5f8fa;
    transition: background-color 0.2s ease;
}
.edit-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.4);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
}
.edit-modal {
    background: white;
    border-radius: 8px;
    padding: 16px;
    width: 90%;
    max-width: 500px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}
.edit-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: bold;
    margin-bottom: 12px;
    font-size: 16px;
}
.edit-textarea {
    width: 100%;
    box-sizing: border-box;
    border: 1px solid #ccc;
    border-radius: 4px;
    padding: 8px;
    font-size: 14px;
    resize: vertical;
    font-family: inherit;
}
.edit-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
}
.btn-cancel {
    padding: 6px 16px;
    border: 1px solid #ccc;
    border-radius: 4px;
    background: white;
    cursor: pointer;
}
.btn-cancel:hover { background: #f0f0f0; }
.btn-submit {
    padding: 6px 16px;
    border: none;
    border-radius: 4px;
    background: #1da1f2;
    color: white;
    cursor: pointer;
}
.btn-submit:hover { background: #1a91da; }
</style>