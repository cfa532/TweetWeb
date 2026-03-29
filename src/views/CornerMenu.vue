<script setup lang="ts">
// share menu or other right click items
import { ref, nextTick, computed, onMounted, onUnmounted } from 'vue'
import { useTweetStore } from '@/stores';
import { useAlertStore } from '@/stores/alert.store';
import { useI18n } from 'vue-i18n';
import type { PropType } from 'vue'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
const tweetStore = useTweetStore()
const alertStore = useAlertStore()
const { t } = useI18n()
const shareMenu = ref<HTMLElement | null>(null)
const dotBtn = ref<HTMLElement | null>(null)
const isMenuOpen = ref(false)
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

function updateMenuPermissions() {
    canDelete.value = false
    canEdit.value = false
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

function positionMenu() {
    if (!dotBtn.value || !shareMenu.value) return
    const rect = dotBtn.value.getBoundingClientRect()
    shareMenu.value.style.top = `${rect.bottom}px`
    shareMenu.value.style.left = `${Math.max(8, rect.right - 220)}px`
}

function openMenu() {
    updateMenuPermissions()
    isMenuOpen.value = true
    requestAnimationFrame(() => positionMenu())
}

function closeMenu() {
    isMenuOpen.value = false
}

function toggleMenu(e: Event) {
    e.preventDefault()
    e.stopPropagation()
    if (isMenuOpen.value) {
        closeMenu()
    } else {
        openMenu()
    }
}

function onViewportChange() {
    if (isMenuOpen.value) {
        positionMenu()
    }
}

onMounted(() => {
    window.addEventListener('resize', onViewportChange)
    window.addEventListener('scroll', onViewportChange, true)
})

onUnmounted(() => {
    window.removeEventListener('resize', onViewportChange)
    window.removeEventListener('scroll', onViewportChange, true)
})
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
    closeMenu()
}

function openEditor() {
  if (!props.tweet) return
  closeMenu()
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
    closeMenu()
    return
  }
  
  closeMenu()
  
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
<div class="corner-menu-root" style="width:100%; text-align: right;">
    <button
        ref="dotBtn"
        type="button"
        class="dot"
        :aria-expanded="isMenuOpen"
        aria-haspopup="true"
        @click="toggleMenu"
    >
        &#8226;&#8226;&bull;
    </button>
    <div v-if="isMenuOpen" class="menu-backdrop" @click="closeMenu" />
    <div
        v-show="isMenuOpen"
        ref="shareMenu"
        class="menu"
        @click.stop
    >
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
.corner-menu-root {
    position: relative;
    display: flex;
    justify-content: flex-end;
    align-items: flex-start;
}

.dot {
    font-size: 15px;
    color: gray;
    margin: 0;
    padding: 0;
    min-width: 44px;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    border-radius: 8px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
    text-decoration: none;
}

.dot:hover,
.dot:focus-visible {
    background: rgba(0, 0, 0, 0.06);
    outline: none;
}

.menu-backdrop {
    position: fixed;
    inset: 0;
    z-index: 99;
}

.menu {
    position: fixed;
    z-index: 100;
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