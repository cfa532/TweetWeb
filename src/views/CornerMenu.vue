<script setup lang="ts">
// share menu or other right click items
import { ref, nextTick, computed, onMounted, onUnmounted, watch } from 'vue'
import { useTweetStore } from '@/stores';
import { useAlertStore } from '@/stores/alert.store';
import { useI18n } from 'vue-i18n';
import type { PropType } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { requireLoginForWritableAction } from '@/lib/authNavigation'
import { copyTextToClipboard, tweetProviderShareUrl, tweetShareUrl } from '@/lib'
import { FontAwesomeIcon } from '@fortawesome/vue-fontawesome'
import EditorModal from '@/components/EditorModal.vue'
const tweetStore = useTweetStore()
const alertStore = useAlertStore()
const { t } = useI18n()
const router = useRouter()
const route = useRoute()
const shareMenu = ref<HTMLElement | null>(null)
const dotBtn = ref<HTMLElement | null>(null)
const isMenuOpen = ref(false)
const canDelete = ref(false)
const canEdit = ref(false)
const showEditor = ref(false)
const showAttachmentEditor = ref(false)
const attachmentEditTweet = ref<Tweet>()
const showDeleteConfirmation = ref(false)
const editContent = ref('')
const isSubmittingEdit = ref(false)
const isAdminEditorOpen = computed(() =>
  (showEditor.value || showAttachmentEditor.value) && tweetStore.loginUser?.username === 'admin'
)
let bodyOverflowBeforeAdminEdit: string | null = null
/** Ignore synthetic click right after touchend so we don't toggle twice (open then close). */
let suppressDotClickFromTouch = false
const props = defineProps({
    tweet: {type: Object as PropType<Tweet>, required: false},
    editTweet: {type: Object as PropType<Tweet>, required: false}, // For retweets: the original tweet to edit (has content); tweet is the wrapper (used for delete)
    parentTweet: {type: Object as PropType<Tweet>, required: false},
    isComment: {type: Boolean, required: false, default: false},
    shareUrlStyle: {
      type: String as PropType<'deeplink' | 'providerIp'>,
      required: false,
      default: 'deeplink',
    },
    afterDelete: {type: Function as PropType<() => void | Promise<void>>, required: false}
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
        const isAdmin = tweetStore.loginUser.username === 'admin'
        const isTweetAuthor = tweetStore.loginUser.mid === props.tweet.authorId
        const isEditTargetAuthor = tweetStore.loginUser.mid === (props.editTweet || props.tweet).authorId
        const isParentTweetAuthor = props.isComment && props.parentTweet && tweetStore.loginUser.mid === props.parentTweet.authorId

        if (isAdmin || isTweetAuthor || isParentTweetAuthor) {
            canDelete.value = true
        }
        if (isAdmin || isEditTargetAuthor) {
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

function toggleMenu(e?: Event) {
    if (e?.type === 'click' && suppressDotClickFromTouch) {
        e.preventDefault()
        e.stopPropagation()
        return
    }
    e?.preventDefault()
    e?.stopPropagation()
    if (isMenuOpen.value) {
        closeMenu()
    } else {
        openMenu()
    }
}

/** Mobile: open/close on touchend; .prevent stops synthetic click (Vue registers non-passive). */
function onDotTouchEnd(e: TouchEvent) {
    e.stopPropagation()
    suppressDotClickFromTouch = true
    toggleMenu()
    window.setTimeout(() => {
        suppressDotClickFromTouch = false
    }, 450)
}

function onDotPointerDown(e: PointerEvent) {
    if (e.pointerType !== 'touch' && e.pointerType !== 'pen') return
    try {
        ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    } catch {
        /* setPointerCapture may throw if target disconnected */
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
    if (bodyOverflowBeforeAdminEdit !== null) {
      document.body.style.overflow = bodyOverflowBeforeAdminEdit
      bodyOverflowBeforeAdminEdit = null
    }
})

watch(isAdminEditorOpen, (blocking) => {
  if (blocking) {
    if (bodyOverflowBeforeAdminEdit === null) {
      bodyOverflowBeforeAdminEdit = document.body.style.overflow
    }
    document.body.style.overflow = 'hidden'
    return
  }
  if (bodyOverflowBeforeAdminEdit !== null) {
    document.body.style.overflow = bodyOverflowBeforeAdminEdit
    bodyOverflowBeforeAdminEdit = null
  }
})
async function copyTweetId() {
    if (!props.tweet) return
    await copyTextToClipboard(props.tweet.mid)
    closeMenu()
}

async function shareTweet() {
    const target = props.editTweet || props.tweet
    if (!target) return
    let url: string | undefined
    if (props.shareUrlStyle === 'providerIp') {
      url = tweetProviderShareUrl(target, tweetStore.appId)
      if (!url) {
        const authorId = target.author?.mid || target.authorId
        const publicIPv4 = await tweetStore.getPublicProviderIPv4(authorId)
        url = tweetProviderShareUrl(target, tweetStore.appId, publicIPv4 ?? undefined)
      }
      if (!url) {
        alertStore.error(t('tweet.publicIpv4Unavailable'))
        closeMenu()
        return
      }
    } else {
      url = tweetShareUrl(target)
    }
    await copyTextToClipboard(url)
    alertStore.success(t('tweet.linkCopied'))
    closeMenu()
}

function openEditor() {
  if (!props.tweet) return
  if (!requireLoginForWritableAction(!!tweetStore.loginUser, router, route.fullPath)) {
    closeMenu()
    return
  }
  closeMenu()
  const target = props.editTweet || props.tweet
  // Top-level tweets live on their author's root node, which is also where
  // EditorModal uploads new files. Admin edits use the same editor and route
  // uploads through the target author. Comments follow their parent author's
  // routing contract and keep the existing content-only path here.
  const canEditAttachments = tweetStore.loginUser?.mid === target.authorId
    || tweetStore.loginUser?.username === 'admin'
  if (!props.isComment && canEditAttachments) {
    attachmentEditTweet.value = target
    showAttachmentEditor.value = true
    return
  }
  editContent.value = target.content || ''
  showEditor.value = true
}

function closeAttachmentEditor() {
  showAttachmentEditor.value = false
  attachmentEditTweet.value = undefined
}

function closeTextEditor() {
  if (isSubmittingEdit.value) return
  showEditor.value = false
}

async function submitEdit() {
  if (!props.tweet || isSubmittingEdit.value) return
  if (!requireLoginForWritableAction(!!tweetStore.loginUser, router, route.fullPath)) {
    showEditor.value = false
    return
  }
  const target = props.editTweet || props.tweet
  isSubmittingEdit.value = true
  try {
    await tweetStore.updateTweet(target.mid, editContent.value, target.authorId)
    target.content = editContent.value
    showEditor.value = false
    alertStore.success(t('tweet.updateSuccess'))
  } catch (error: any) {
    alertStore.error(error, { fallbackMessage: t('tweet.failedUpdateTweet') })
  } finally {
    isSubmittingEdit.value = false
  }
}

function requestDeleteItem() {
  if (!props.tweet) {
    closeMenu()
    return
  }
  if (!requireLoginForWritableAction(!!tweetStore.loginUser, router, route.fullPath)) {
    closeMenu()
    return
  }

  closeMenu()
  showDeleteConfirmation.value = true
}

async function confirmDeleteItem() {
  showDeleteConfirmation.value = false
  if (!props.tweet) {
    closeMenu()
    return
  }
  if (!requireLoginForWritableAction(!!tweetStore.loginUser, router, route.fullPath)) {
    closeMenu()
    return
  }
  const loginUser = tweetStore.loginUser
  if (!loginUser) {
    closeMenu()
    return
  }
  
  closeMenu()
  const isAdmin = loginUser.username === 'admin'
  try {
    if (props.isComment && props.parentTweet) {
      // Delete comment - requires comment author OR parent tweet author OR admin
      if (isAdmin || loginUser.mid === props.tweet.authorId || loginUser.mid === props.parentTweet.authorId) {
        const commentIdToDelete = props.tweet.mid
        const parentTweet = props.parentTweet
        const previousComments = Array.isArray(parentTweet.comments) ? [...parentTweet.comments] : undefined
        const previousCount = parentTweet.commentCount

        // Remove optimistically so the UI updates immediately; roll back if the
        // server call fails (e.g. writable host is unavailable).
        if (previousComments) {
          parentTweet.comments = previousComments.filter((c: Tweet) => c && c.mid !== commentIdToDelete)
          if (previousCount !== undefined) {
            parentTweet.commentCount = Math.max(0, (previousCount || 0) - 1)
          }
          await nextTick()
        }

        try {
          await tweetStore.deleteComment(
            commentIdToDelete,
            props.tweet.authorId,
            props.parentTweet.mid,
            props.parentTweet.authorId
          )
        } catch (error) {
          if (previousComments) {
            parentTweet.comments = previousComments
            parentTweet.commentCount = previousCount
          }
          throw error
        }
      }
    } else {
      // Delete regular tweet - requires tweet author OR admin
      if (isAdmin || loginUser.mid === props.tweet.authorId) {
        // deleteTweet removes the tweet from local state synchronously before
        // its first network await. Start navigation immediately after that
        // optimistic removal instead of waiting for server confirmation.
        const deletion = tweetStore.deleteTweet(props.tweet.mid, props.tweet.authorId)
        const navigation = props.afterDelete?.()
        const [deletionResult, navigationResult] = await Promise.allSettled([deletion, navigation])

        if (navigationResult.status === 'rejected') {
          console.error('[CornerMenu] Failed to leave deleted tweet detail', navigationResult.reason)
        }
        if (deletionResult.status === 'rejected') {
          throw deletionResult.reason
        }
      }
    }
  } catch (error: any) {
    alertStore.error(error, { fallbackMessage: t('tweet.failedDeleteTweet') })
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
        @pointerdown="onDotPointerDown"
        @touchend.stop.prevent="onDotTouchEnd"
        @click.stop.prevent="toggleMenu"
    >
        &#8226;&#8226;&bull;
    </button>
    <Teleport to="body">
      <div v-if="isMenuOpen" class="menu-backdrop" @click="closeMenu" />
      <div
          v-show="isMenuOpen"
          ref="shareMenu"
          class="menu"
          @click.stop
      >
          <div class="item copy-item" @click.stop="copyTweetId">
              <span class="menu-text">
                  <font-awesome-icon icon="copy" style="margin-right: 5px;" /> {{ displayMid }}
              </span>
          </div>
          <div v-if="tweet" class="item clickable-item" @click.stop="shareTweet">
              <span class="menu-text"><font-awesome-icon icon="share-from-square" style="margin-right: 5px;" />{{ $t('tweet.share') }}</span>
          </div>
          <div v-if="canEdit" class="item clickable-item" @click.stop="openEditor">
              <span class="menu-text"><font-awesome-icon icon="pen" style="margin-right: 5px;" />{{ $t('common.edit') }}</span>
          </div>
          <div v-if="canDelete" class="item clickable-item" @click.stop="requestDeleteItem">
              <span class="menu-text"><font-awesome-icon icon="trash-can" style="margin-right: 5px;" />{{ $t('common.delete') }}</span>
          </div>
      </div>
    </Teleport>
</div>

<!-- Edit Modal -->
<Teleport to="body">
<div v-if="showEditor" class="edit-overlay" @click.stop>
    <section
        class="edit-modal"
        role="dialog"
        aria-modal="true"
        :aria-busy="isSubmittingEdit"
        :aria-label="$t('tweet.editTweet')"
        @click.stop
    >
        <div class="edit-header">
            <span>{{ $t('tweet.editTweet') }}</span>
            <button class="edit-close" type="button" :disabled="isSubmittingEdit" @click="closeTextEditor">&times;</button>
        </div>
        <textarea v-model="editContent" class="edit-textarea" rows="6" :disabled="isSubmittingEdit"></textarea>
        <div class="edit-actions">
            <button class="btn-cancel" :disabled="isSubmittingEdit" @click="closeTextEditor">{{ $t('common.cancel') }}</button>
            <button class="btn-submit" :disabled="isSubmittingEdit" @click="submitEdit">{{ $t('common.save') }}</button>
        </div>
    </section>
</div>
</Teleport>

<!-- The login user's own tweets use the full attachment-capable editor. -->
<Teleport to="body">
<div v-if="showAttachmentEditor" class="edit-overlay" @click.stop>
    <div class="edit-modal edit-modal--attachments" @click.stop>
        <EditorModal
            v-if="attachmentEditTweet"
            :edit-tweet="attachmentEditTweet"
            @hide="closeAttachmentEditor"
        />
    </div>
</div>
</Teleport>

<!-- Delete Confirmation -->
<Teleport to="body">
<div v-if="showDeleteConfirmation" class="confirm-overlay" @click.self="showDeleteConfirmation = false">
    <section
        class="confirm-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="$t(props.isComment ? 'tweet.deleteCommentConfirmTitle' : 'tweet.deleteTweetConfirmTitle')"
        @click.stop
    >
        <h2 class="confirm-title">{{ $t(props.isComment ? 'tweet.deleteCommentConfirmTitle' : 'tweet.deleteTweetConfirmTitle') }}</h2>
        <p class="confirm-message">{{ $t(props.isComment ? 'tweet.deleteCommentConfirmMessage' : 'tweet.deleteTweetConfirmMessage') }}</p>
        <div class="confirm-actions">
            <button class="btn-cancel" @click="showDeleteConfirmation = false">{{ $t('common.cancel') }}</button>
            <button class="btn-delete" @click="confirmDeleteItem">{{ $t('common.delete') }}</button>
        </div>
    </section>
</div>
</Teleport>
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
    position: relative;
    z-index: 1;
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
.edit-overlay,
.confirm-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.4);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
}
.edit-modal,
.confirm-modal {
    background: white;
    border-radius: 8px;
    padding: 16px;
    width: 90%;
    max-width: 500px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.3);
}
.edit-modal--attachments {
    max-width: var(--content-max-width);
    max-height: calc(100vh - 32px);
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
}
.confirm-title {
    margin: 0 0 12px;
    font-size: 18px;
}
.confirm-message {
    margin: 0;
    color: #4a4a4a;
    line-height: 1.45;
}
.confirm-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 20px;
}
.edit-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-weight: bold;
    margin-bottom: 12px;
    font-size: 16px;
}
.edit-close {
    border: none;
    background: transparent;
    color: grey;
    padding: 0 4px;
    font-size: 24px;
    line-height: 1;
    cursor: pointer;
}
.edit-close:disabled,
.btn-cancel:disabled,
.btn-submit:disabled {
    cursor: not-allowed;
    opacity: 0.6;
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
.btn-delete {
    padding: 6px 16px;
    border: none;
    border-radius: 4px;
    background: #d93025;
    color: white;
    cursor: pointer;
}
.btn-delete:hover { background: #b3261e; }
</style>
