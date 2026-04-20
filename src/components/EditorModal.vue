<script setup lang='ts'>
import { ref, reactive, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loading, Preview, CidPreview } from '@/views'
import { useTweetStore, useAlertStore } from '@/stores'
import { useRoute, useRouter } from 'vue-router';
import IconLink from '@/components/icons/IconLink.vue'
import { CidModal } from '@/views'
import { compressImage, uploadVideo, normalizeVideo, getVideoAspectRatio, getImageAspectRatio, getMediaType } from '@/utils/uploadUtils'
import { MEDIA_TYPES, isVideoType, isImageType } from '@/lib'

interface HTMLInputEvent extends Event {
  target: HTMLInputElement & EventTarget
}
const { t } = useI18n();
const emit = defineEmits(['uploaded', 'hide'])
const route = useRoute()
const router = useRouter()
const tweetId = computed(() => route.params.tweetId as MimeiId | undefined)
const tweetTitle = ref()
const txtConent = ref()
const divAttach = ref()
const dropHere = ref()
const textArea = ref<HTMLTextAreaElement>()
const filesUpload = ref<File[]>([])
const uploadProgress = reactive<number[]>([])    // upload progress of each file
const draggedIndex = ref<number | null>(null)
const dragOverIndex = ref<number | null>(null)
const loading = ref(false)
const submitFailed = ref(false)
const selectFiles = ref()
const isPrivate = ref(false)
const downloadable = ref(true)  // whether the attachment is downloadable
const noResample = ref(false)   // whether to preserve original video quality
const isQuoting = ref(false)    // whether to also post as a quote tweet (comment mode only)
const tweetStore = useTweetStore()
const tweet = ref<Tweet>()
const author = tweetStore.loginUser!  // the page is accessible only by login user.
const mmFiles = ref<MimeiFileType[]>([]);
const showCidModal = ref(false);

const MAX_UPLOAD_SIZE = 4 * 1024 * 1024 * 1024; // 4GB
const SMALL_VIDEO_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50MB

// Retry configuration for uploads
const UPLOAD_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelay: 1000, // 1 second
  maxDelay: 10000, // 10 seconds
  backoffMultiplier: 2
}

// Utility function to determine if an error is retryable
function isRetryableError(error: any): boolean {
  if (!error) return false;

  const errorMessage = error instanceof Error ? error.message : String(error);
  const retryablePatterns = [
    'timeout',
    'Connection request timeout',
    'Network error',
    'ECONNRESET',
    'ENOTFOUND',
    'ECONNREFUSED',
    'fetch failed',
    'Failed to fetch'
  ];

  return retryablePatterns.some(pattern =>
    errorMessage.toLowerCase().includes(pattern.toLowerCase())
  );
}

// Generic retry wrapper for upload functions
async function retryUpload<T>(
  uploadFn: () => Promise<T>,
  fileName: string,
  config = UPLOAD_RETRY_CONFIG
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await uploadFn();
    } catch (error) {
      lastError = error;
      console.error(`[UPLOAD-RETRY] Attempt ${attempt + 1}/${config.maxRetries + 1} failed for ${fileName}:`, error);

      // Clear connection pool on connection timeout — pool may hold stale sockets.
      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('Connection request timeout')) {
        tweetStore.lapi.connectionPool.clearAll();
      }

      if (attempt >= config.maxRetries || !isRetryableError(error)) break;

      const delay = Math.min(
        config.initialDelay * Math.pow(config.backoffMultiplier, attempt),
        config.maxDelay
      );
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}

onMounted(() => {
  tweet.value = { mid: 'dfdfd', authorId: author.mid, author: author, timestamp: Date.now() }
})

// Upload files and store them as IPFS or Mimei type
async function uploadAttachedFiles(files: File[]): Promise<PromiseSettledResult<MimeiFileType>[]> {
  const results: PromiseSettledResult<MimeiFileType>[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      // Assign initial progress value
      uploadProgress[i] = 0;

      const fileType = getMediaType(file.type, file.name);
      let processedFile = file;
      let cid: string = '';

      if (isImageType(fileType)) {
        cid = await retryUpload(() => uploadFileFromFile(file, i), file.name);

      } else if (isVideoType(fileType)) {
        // Upload video through new endpoint or fallback to IPFS
        uploadProgress[i] = 5; // Show initial progress
        
        let useIPFSFallback = false;
        let fallbackReason: string | null = null;
        let shouldWarnFallback = false;
        let isHLSConverted = false; // Track if video was converted to HLS
        
        if (file.size <= SMALL_VIDEO_THRESHOLD_BYTES) {
          // Small videos go direct-to-IPFS (progressive MP4) — the intended route,
          // no fallback warning.
          useIPFSFallback = true;
        } else if (!author.cloudDrivePort) {
          // null/undefined/0: no backend HLS service configured.
          useIPFSFallback = true;
          fallbackReason = 'cloudDrivePort not configured';
          shouldWarnFallback = true;
        } else {
          const cloudDrivePort = String(author.cloudDrivePort);
          let ipAddress: string | null = null;
          try {
            const resolved = await tweetStore.resolveWritableHostIp(author);
            ipAddress = resolved.includes(':') ? resolved.split(':')[0] : resolved;
          } catch (resolveError) {
            useIPFSFallback = true;
            fallbackReason = `Failed to resolve writable host: ${resolveError instanceof Error ? resolveError.message : resolveError}`;
            shouldWarnFallback = true;
          }

          const baseUrl = ipAddress ? `http://${ipAddress}:${cloudDrivePort}` : '';
          const serviceAvailable = ipAddress ? await checkServiceAvailability(baseUrl) : false;

          if (!useIPFSFallback && !serviceAvailable) {
            useIPFSFallback = true;
            fallbackReason = `Backend service at ${baseUrl} is not available (health check failed)`;
            shouldWarnFallback = true;
          } else if (!useIPFSFallback) {
            cid = await retryUpload(
              () => uploadVideo(
                file,
                baseUrl,
                cloudDrivePort,
                (progress) => { uploadProgress[i] = progress; },
                noResample.value
              ),
              file.name
            );

            if (!cid || cid.trim() === '') {
              throw new Error('Video upload failed: No CID returned from server');
            }

            isHLSConverted = true;
            uploadProgress[i] = 100;
          }
        }

        // Fallback path: small videos, missing/unreachable cloudDrivePort, or
        // resolution failure — all land here and upload progressive MP4 via upload_ipfs.
        if (useIPFSFallback) {
          if (shouldWarnFallback && fallbackReason) {
            useAlertStore().warning(`Video upload using IPFS fallback: ${fallbackReason}`);
          }
          cid = await retryUpload(() => uploadFileFromFile(file, i), file.name);
        }
        
        // Store HLS conversion status for later use
        (file as any).__isHLSConverted = isHLSConverted;
        
      } else {
        // Handle other file types with new upload_ipfs API (matches iOS)
        cid = await retryUpload(
          () => uploadFileFromFile(processedFile, i),
          file.name
        );
      }

      const aspectRatio = isVideoType(fileType) ? await getVideoAspectRatio(file) :
                         isImageType(fileType) ? await getImageAspectRatio(file) : null;

      const fi = {
        mid: cid,
        type: isVideoType(fileType) ? ((file as any).__isHLSConverted ? MEDIA_TYPES.HLS_VIDEO : MEDIA_TYPES.VIDEO) : fileType,
        size: processedFile.size,
        fileName: file.name,
        timestamp: file.lastModified,
        aspectRatio: aspectRatio
      } as MimeiFileType;

      results.push({ status: 'fulfilled', value: fi });

    } catch (error) {
      console.error(`Error uploading file ${file.name}:`, error);
      
      // Provide more specific error messages
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      let finalErrorMessage = errorMessage;
      
      if (errorMessage.includes('Network error')) {
        finalErrorMessage = `Network error uploading ${file.name}. Please check your connection and try again.`;
      } else if (errorMessage.includes('timeout')) {
        finalErrorMessage = `Upload timeout for ${file.name}. The file may be too large or the server is busy.`;
      } else if (errorMessage.includes('exceeds the maximum')) {
        finalErrorMessage = `File ${file.name} is too large. Maximum size is 4GB.`;
      } else if (errorMessage.includes('No CID returned')) {
        finalErrorMessage = `Video processing failed for ${file.name}. Please try again.`;
      }
      
      results.push({ status: 'rejected', reason: new Error(finalErrorMessage) });
    }
  }

  return results;
}

async function onSubmit() {
  if (!tweetStore.loginUser) {
    useAlertStore().error(t('editor.loginToPost'))
    return
  }

  loading.value = true
  let attachments = <MimeiFileType[]>[]
  try {
    if (filesUpload.value.length > 0) {
      attachments = (await uploadAttachedFiles(filesUpload.value))
        .filter((v) => v.status === 'fulfilled')
        .map((v: any) => v.value)
      if (attachments.length < filesUpload.value.length) {
        throw new Error('Attachments uploading failed')
      }
    }

    const tweet = {
      authorId: tweetStore.loginUser.mid,
      title: tweetTitle.value,
      content: txtConent.value,
      attachments: attachments.concat(mmFiles.value),
      isPrivate: isPrivate.value,
      downloadable: downloadable.value,
      timestamp: Date.now(),
    }

    const targetTweetId = tweetId.value as MimeiId
    const result = await tweetStore.uploadTweet(tweet, targetTweetId)
    if (!result) {
      throw new Error('Tweet upload failed: No response from server')
    }

    useAlertStore().success(t('editor.tweetUploaded'))
    submitFailed.value = false

    // Clear form only on success
    txtConent.value = null
    tweetTitle.value = null
    filesUpload.value = []
    mmFiles.value = []
    noResample.value = false

    // Fetch parent tweet once — used for both quote tweet and navigation
    let parentTweet = null
    if (targetTweetId) {
      try {
        parentTweet = await tweetStore.getTweet(targetTweetId)
      } catch (e) {
        console.warn('[TWEET-SUBMIT] Could not fetch parent tweet:', e)
      }
    }

    // If quoting, also publish as a standalone quote tweet
    if (targetTweetId && isQuoting.value && parentTweet) {
      try {
        const quoteTweet = {
          ...tweet,
          originalTweetId: targetTweetId,
          originalAuthorId: parentTweet.authorId,
          timestamp: Date.now(),
        }
        const quoteMid = await tweetStore.uploadTweet(quoteTweet, undefined)
        if (quoteMid) {
          await tweetStore.updateRetweetCount(parentTweet, quoteMid)
        }
      } catch (quoteError) {
        console.warn('[TWEET-SUBMIT] Quote tweet upload failed (comment still posted):', quoteError)
      }
    }

    if (targetTweetId) {
      const params: any = { tweetId: targetTweetId }
      if (parentTweet?.author) params.authorId = parentTweet.author.mid
      router.push({ name: 'TweetDetail', params })
    } else {
      emit('uploaded', result)
      emit('hide')
    }
  } catch (err) {
    console.error('onSubmit err:', err)
    useAlertStore().error(err instanceof Error ? err.message : String(err))
    submitFailed.value = true

    // Refresh loginUser: clear per-user cache and re-fetch, overwriting
    // _user and sessionStorage['user'] in place (never null them first).
    const mid = tweetStore.loginUser?.mid
    if (mid) {
      tweetStore.removeUser(mid)
      const freshUser = await tweetStore.getUser(mid, true)
      if (freshUser) {
        tweetStore._user = freshUser
        sessionStorage.setItem('user', JSON.stringify(freshUser))
      }
    }
  } finally {
    loading.value = false
  }
}

// Upload a file via upload_ipfs (store helper handles writable-host resolution
// and chunking).
async function uploadFileFromFile(file: File, fileIndex: number): Promise<string> {
  if (!tweetStore.loginUser) throw new Error('Not logged in')
  const data = await file.arrayBuffer()
  const cid = await tweetStore.uploadBlobToIpfs(
    tweetStore.loginUser,
    data,
    (percent) => { uploadProgress[fileIndex] = percent }
  )
  uploadProgress[fileIndex] = 100
  return cid
}

// Check if the cloud drive service is available at the specified URL
async function checkServiceAvailability(baseUrl: string): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    }).catch(() => null);

    clearTimeout(timeoutId);

    if (response?.ok) {
      const data = await response.json().catch(() => null);
      return data?.status === 'ok';
    }
    return false;
  } catch {
    return false;
  }
}

async function onSelect(e: Event) {
  let files =
    (e as HTMLInputEvent).target.files ||       // select input file
    (e as DragEvent).dataTransfer?.files ||     // drag and drop
    (e as ClipboardEvent).clipboardData?.files  // copy and paste

  if (files && files.length > 0) {
    let totalSize = 0;
    filesUpload.value.forEach(f => totalSize += f.size);

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      totalSize += file.size;

      if (totalSize > MAX_UPLOAD_SIZE) {
        useAlertStore().error(t('editor.uploadSizeExceeds'));
        return; // Stop adding files
      }

      // Assign content if neither title nor content is set
      if (!tweetTitle.value && !txtConent.value) {
        txtConent.value = file.name.replace(/\.[^.]+$/, '');
      }

      // Remove duplication and add files to the upload list
      if (
        filesUpload.value.findIndex((e: File) => {
          return e.size === file.size && e.name === file.name
        }) === -1
      ) {
        filesUpload.value.push(file)
      }
    }

    divAttach.value!.hidden = false;
    textArea.value!.hidden = false;
    dropHere.value!.hidden = true;
  } else {
    // Clipboard works only with HTTPS
    if ((e.target as HTMLTextAreaElement) === textArea.value) {
      // Paste into text area
      document.execCommand('paste');
    }
  }
}

function dragOver() {
  textArea!.value!.hidden = true
  dropHere!.value!.hidden = false
}

function dragLeave(e: DragEvent) {
  // Only hide the drop zone if we're leaving the modal-content container entirely
  // Check if the related target is still within the modal-content
  const modalContent = (e.currentTarget as HTMLElement)
  const relatedTarget = e.relatedTarget as HTMLElement

  if (!modalContent.contains(relatedTarget)) {
    textArea!.value!.hidden = false
    dropHere!.value!.hidden = true
  }
}

function removeFile(f: File) {
  // removed file from preview list
  var i = filesUpload.value.findIndex((e: File) => e == f)
  filesUpload.value.splice(i, 1)
}

function goBack() {
  router.back()
}

function openUserPage() {
  tweetStore.addFollowing(author.mid)
  router.push(`/author/${author.mid}`)
}

const handleCids = (ids: MimeiFileType[]) => {
  mmFiles.value = ids;
  showCidModal.value = false;
  if (ids.length > 0) {
    divAttach.value.hidden = false
    if (!tweetTitle.value && !txtConent.value) {
      txtConent.value = ids[0].fileName?.replace(/\.[^.]+$/, '') || '';
    }
  }
};
const cancelCidsModal = () => {
  showCidModal.value = false;
};
const openModal = () => {
  showCidModal.value = true;
}
function removeMimei(m: MimeiFileType) {
  const i = mmFiles.value.findIndex((e) => e.mid == m.mid)
  mmFiles.value.splice(i, 1)
  if (filesUpload.value.length == 0 && mmFiles.value.length == 0) {
    divAttach.value.hidden = true
  }
}

// Drag and drop handlers for reordering files
function handleDragStart(index: number) {
  draggedIndex.value = index
}

function handleDragOver(e: DragEvent, index: number) {
  e.preventDefault()
  dragOverIndex.value = index
}

function handleDragLeave() {
  dragOverIndex.value = null
}

function handleDrop(e: DragEvent, dropIndex: number) {
  e.preventDefault()
  
  if (draggedIndex.value === null || draggedIndex.value === dropIndex) {
    draggedIndex.value = null
    dragOverIndex.value = null
    return
  }
  
  // Reorder files
  const draggedFile = filesUpload.value[draggedIndex.value]
  const draggedProgress = uploadProgress[draggedIndex.value]
  
  // Remove from original position
  filesUpload.value.splice(draggedIndex.value, 1)
  uploadProgress.splice(draggedIndex.value, 1)
  
  // Adjust drop index if needed (since we removed an item)
  const adjustedDropIndex = draggedIndex.value < dropIndex ? dropIndex - 1 : dropIndex
  
  // Insert at new position
  filesUpload.value.splice(adjustedDropIndex, 0, draggedFile)
  uploadProgress.splice(adjustedDropIndex, 0, draggedProgress)
  
  // Reset drag state
  draggedIndex.value = null
  dragOverIndex.value = null
}

function handleDragEnd() {
  draggedIndex.value = null
  dragOverIndex.value = null
}
</script>

<template>
  <CidModal :isVisible="showCidModal" @save="handleCids" @cancel="cancelCidsModal" />

  <div style='background-color:aliceblue;'>
      <div class='editor-header'>
        <img :src='author.avatar' alt='Avatar' class='editor-avatar' @click='openUserPage' style='cursor:pointer'>
        <div class='editor-author' @click='openUserPage' style='cursor:pointer'>
          <div class='fw-bold'>{{ author.name }}</div>
          <div class='text-muted' style='font-size:0.85rem'>@{{ author.username }}</div>
        </div>
        <div class='cancel-btn' @click='goBack'>
          <font-awesome-icon icon="circle-xmark" size="xl" />
        </div>
      </div>
      <div class='editor-content' @dragover.prevent='dragOver' @dragleave='dragLeave' @drop.prevent='onSelect'>
        <div>
          <input type='text' :placeholder="$t('editor.titlePlaceholder')" v-model='tweetTitle' class='input-caption' />
        </div>
        <div class='input-container'>
          <textarea ref='textArea' v-model='txtConent' :placeholder="$t('editor.contentPlaceholder')" class='input-textarea'></textarea>
          <div ref='dropHere' hidden class='drop-here'>
            <p>{{ $t('editor.dropHere') }}</p>
          </div>
        </div>
        <form @submit.prevent='onSubmit' enctype='multipart/form-data' @paste.prevent='onSelect' class='form-container'>
          <input ref='selectFiles' @change='onSelect' type='file' hidden multiple />
          <div class='button-container'>
            <span>
              <button class='btn' @click.prevent='selectFiles.click()'>{{ $t('editor.files') }}</button>&nbsp;
              <label class="bottom-btn" @click.prevent="openModal">
                <IconLink />
              </label>
            </span>
            <span>
              <input type='checkbox' v-model='downloadable' id='downloadable-checkbox'>&nbsp;
              <label for='downloadable-checkbox'>{{ $t('editor.downloadable') }}</label>&nbsp;&nbsp;&nbsp;
              <input type='checkbox' v-model='isPrivate' id='private-checkbox'>&nbsp;
              <label for='private-checkbox'>{{ $t('editor.private') }}</label>&nbsp;&nbsp;&nbsp;
              <input type='checkbox' v-model='noResample' id='noresample-checkbox'>&nbsp;
              <label for='noresample-checkbox' :title="$t('editor.preserveQualityTitle')">{{ $t('editor.preserveQuality') }}</label>&nbsp;&nbsp;&nbsp;
              <template v-if='tweetId'>
                <input type='checkbox' v-model='isQuoting' id='quoting-checkbox'>&nbsp;
                <label for='quoting-checkbox'>{{ $t('editor.quoteTweet') }}</label>&nbsp;&nbsp;&nbsp;
              </template>
              <button class='btn' type='submit'>{{ submitFailed ? $t('editor.resubmit') : $t('common.submit') }}</button>
            </span>
          </div>
          <Loading :visible='loading' />
        </form>
      </div>
      <div ref='divAttach' hidden class='preview-container'>
        <Preview 
          @file-canceled='removeFile(file)' 
          v-for='(file, index) in filesUpload' 
          :key='index' 
          v-bind:src='file'
          v-bind:progress='uploadProgress[index]'
          :dragged="draggedIndex === index"
          :drag-over="dragOverIndex === index"
          @drag-start="handleDragStart(index)"
          @drag-over="handleDragOver($event, index)"
          @drag-leave="handleDragLeave"
          @drop="handleDrop($event, index)"
          @drag-end="handleDragEnd"
        ></Preview>
        <CidPreview @link-removed="removeMimei(m)" v-for="(m, index) in mmFiles" :key="index"
          :src="m.fileName as string" />
      </div>
    </div>
</template>

<style scoped>
.input-caption {
  border: 0px;
  width: 98%;
  margin: 8px 8px 8px 8px;
}

.editor-header {
  display: flex;
  align-items: center;
  padding: 8px 10px;
}

.editor-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  margin-right: 8px;
}

.editor-author {
  flex: 1;
}

.cancel-btn {
  cursor: pointer;
  color: #e0245e;
  padding: 4px;
  margin-right: 6px;
}

.editor-content {
  width: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background-color: #ebf0f3;
  border: 1px solid #888;
  margin: 10px 0 0 0;
  flex-direction: column;
  flex: 1;
}

.input-container {
  flex: 1;
  margin-bottom: 10px;
  display: inline;
}

.input-textarea {
  margin: 5px;
  border: 1px solid lightgrey;
  width: 99%;
  height: 40vh;
  border-radius: 5px;
}

.drop-here {
  border: 1px solid lightgrey;
  width: 100%;
  height: 400px;
  margin: 0px;
  text-align: center;
}

.preview-container {
  width: 100%;
  margin: 10px;
  left: 0;
  border: 0px solid lightgray;
  border-radius: 5px;
  margin-bottom: 6px;
  padding-top: 0px;
}

.form-container {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.button-container {
  height: auto;
  display: flex;
  justify-content: space-between;
  margin: 10px
}

.btn {
  border-radius: 5px;
  border: 1px solid rgb(26, 25, 25);
  padding: 3px 10px;
}

.bottom-btn {
  display: inline-flex;
  align-items: center;
  border: none;
  border-radius: 5px;
  cursor: pointer;
  font-size: 16px;
  fill: rgb(48, 46, 46);
  transition: background-color 0.3s;
}

.bottom-btn svg {
  padding-top: 6px;
  margin-right: 10px;
  width: 24px;
  height: 24px;
}
</style>