<script setup lang='ts'>
import { ref, reactive, onMounted, computed } from 'vue'
import { Loading, Preview, ItemHeader, CidPreview } from '@/views'
import { useTweetStore, useAlertStore } from '@/stores'
import { useRoute, useRouter } from 'vue-router';
import IconLink from '@/components/icons/IconLink.vue'
import { CidModal } from '@/views'
import { compressImage, uploadVideo, normalizeVideo, getVideoAspectRatio, getImageAspectRatio, getMediaType } from '@/utils/uploadUtils'
import { MEDIA_TYPES, isVideoType, isImageType } from '@/lib'

// Helper function to get human-readable aspect ratio names
function getAspectRatioDisplayName(ratio: number): string {
  const tolerance = 0.01;
  if (Math.abs(ratio - (4/3)) < tolerance) return '4:3';
  if (Math.abs(ratio - (16/9)) < tolerance) return '16:9';
  if (Math.abs(ratio - (21/9)) < tolerance) return '21:9';
  if (Math.abs(ratio - (16/10)) < tolerance) return '16:10';
  if (Math.abs(ratio - (9/16)) < tolerance) return '9:16 (portrait)';
  if (Math.abs(ratio - 1) < tolerance) return '1:1 (square)';
  return `${ratio.toFixed(3)}:1`;
}

interface HTMLInputEvent extends Event {
  target: HTMLInputElement & EventTarget
}
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
const selectFiles = ref()
const isPrivate = ref(false)
const downloadable = ref(true)  // whether the attachment is downloadable
const noResample = ref(false)   // whether to preserve original video quality
const tweetStore = useTweetStore()
const tweet = ref<Tweet>()
const author = tweetStore.loginUser!  // the page is accessible only by login user.
const mmFiles = ref<MimeiFileType[]>([]);
const showCidModal = ref(false);

const MAX_UPLOAD_SIZE = 4 * 1024 * 1024 * 1024; // 4GB
const SMALL_VIDEO_THRESHOLD_BYTES = 50 * 1024 * 1024; // 50MB

onMounted(() => {
  tweet.value = { mid: 'dfdfd', authorId: author.mid, author: author, timestamp: Date.now() }
  console.log('EditorModal mounted with author:', {
    mid: author.mid,
    providerIp: author.providerIp,
    cloudDrivePort: author.cloudDrivePort
  });
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

      // Handle different file types
      if (isImageType(fileType)) {
        // Compress image to under 2MB
        processedFile = await compressImage(file);
        uploadProgress[i] = 50; // Show progress for compression
        
        // Upload compressed image using new upload_ipfs API (matches iOS)
        cid = await uploadFileToIPFS(await processedFile.arrayBuffer(), i, file.name);
        
      } else if (isVideoType(fileType)) {
        // Upload video through new endpoint or fallback to IPFS
        uploadProgress[i] = 5; // Show initial progress
        
        let useIPFSFallback = false;
        let fallbackReason: string | null = null;
        let shouldWarnFallback = false;
        let isHLSConverted = false; // Track if video was converted to HLS
        
        if (file.size <= SMALL_VIDEO_THRESHOLD_BYTES) {
          // For small videos (<50MB), use direct IPFS upload route
          useIPFSFallback = true;
          fallbackReason = null; // No warning needed, this is the intended route
        } else {
          // Check 1: Is cloudDrivePort null, undefined, or 0?
          // Note: 0 explicitly means "no service available"
          if (author.cloudDrivePort === null || author.cloudDrivePort === undefined) {
            useIPFSFallback = true;
            fallbackReason = 'cloudDrivePort is null or undefined';
            console.warn(`Video upload: ${fallbackReason}, using IPFS fallback`);
            shouldWarnFallback = true;
          } else if (author.cloudDrivePort === 0) {
            useIPFSFallback = true;
            fallbackReason = 'cloudDrivePort is 0 (no service available)';
            console.warn(`Video upload: ${fallbackReason}, using IPFS fallback`);
            shouldWarnFallback = true;
          } else {
            // cloudDrivePort has a valid value - check if backend service is available
            // Call /health endpoint to verify service is running
            const cloudDrivePort = author.cloudDrivePort.toString();
            
            // Extract IP address from providerIp (which might include a port)
            let ipAddress = author.providerIp || '';
            if (ipAddress.includes(':')) {
              // Remove port from providerIp if it exists
              ipAddress = ipAddress.split(':')[0];
            }
            
            // Check 2: Call /health endpoint to verify service is alive
            const baseUrl = `http://${ipAddress}:${cloudDrivePort}`;
            const serviceAvailable = await checkServiceAvailability(baseUrl);
            
            if (!serviceAvailable) {
              useIPFSFallback = true;
              fallbackReason = `Backend service at ${baseUrl} is not available (health check failed)`;
              console.warn(`Video upload: ${fallbackReason}, using IPFS fallback`);
              shouldWarnFallback = true;
            } else {
              console.log('Video upload parameters:', {
                originalProviderIp: author.providerIp,
                extractedIpAddress: ipAddress,
                cloudDrivePort: cloudDrivePort,
                baseUrl: baseUrl,
                noResample: noResample.value
              });
              
              // Service is available, use regular video upload
              console.log(`Starting video upload for ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)}MB)`);
              cid = await uploadVideo(
                file, 
                baseUrl, 
                cloudDrivePort,
                (progress) => {
                  // Update progress based on job processing progress
                  uploadProgress[i] = progress;
                  console.log(`Processing progress for ${file.name}: ${uploadProgress[i]}%`);
                },
                noResample.value
              );
              
              // Validate that we received a valid CID
              if (!cid || cid.trim() === '') {
                throw new Error('Video upload failed: No CID returned from server');
              }
              
              isHLSConverted = true; // Video was successfully converted to HLS
              uploadProgress[i] = 100; // Complete
            }
          }
        }
        
        // Use IPFS upload if needed (for small videos <50MB or as fallback)
        if (useIPFSFallback) {
          const reasonText = fallbackReason ? ` (Reason: ${fallbackReason})` : '';
          if (fallbackReason) {
            console.log(`Using IPFS upload for video: ${file.name}${reasonText}`);
          } else {
            console.log(`Using direct IPFS upload for small video: ${file.name}`);
          }
          if (shouldWarnFallback && fallbackReason) {
            useAlertStore().warning(`Video upload using IPFS fallback: ${fallbackReason}`);
          }
          
          // Use the new upload_ipfs API (matches iOS)
          cid = await uploadFileToIPFS(await file.arrayBuffer(), i, file.name);
        }
        
        // Store HLS conversion status for later use
        (file as any).__isHLSConverted = isHLSConverted;
        
      } else {
        // Handle other file types with new upload_ipfs API (matches iOS)
        cid = await uploadFileToIPFS(await processedFile.arrayBuffer(), i, file.name);
      }

      const aspectRatio = isVideoType(fileType) ? await getVideoAspectRatio(file) : 
                         isImageType(fileType) ? await getImageAspectRatio(file) : null;
      
      // Log aspect ratio detection result
      if (isVideoType(fileType) && aspectRatio) {
        console.log(`🎬 [VIDEO PREVIEW] File: ${file.name}`);
        console.log(`📐 [VIDEO PREVIEW] Detected aspect ratio: ${aspectRatio.toFixed(3)} (${getAspectRatioDisplayName(aspectRatio)})`);
      } else if (isImageType(fileType) && aspectRatio) {
        console.log(`🖼️ [IMAGE PREVIEW] File: ${file.name}`);
        console.log(`📐 [IMAGE PREVIEW] Detected aspect ratio: ${aspectRatio.toFixed(3)} (${getAspectRatioDisplayName(aspectRatio)})`);
      }
      
      const fi = {
        mid: cid,
        type: isVideoType(fileType) ? ((file as any).__isHLSConverted ? MEDIA_TYPES.HLS_VIDEO : MEDIA_TYPES.VIDEO) : fileType,
        size: processedFile.size,
        fileName: file.name,
        timestamp: file.lastModified,
        aspectRatio: aspectRatio
      } as MimeiFileType;

      console.log(`📋 [PREVIEW RESULT]`, fi);
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
  console.log('[TWEET-SUBMIT] Starting tweet submission...');
  
  // Check if user is logged in (matches iOS behavior)
  if (!tweetStore.loginUser) {
    useAlertStore().error('Please log in to post a tweet')
    return
  }
  
  loading.value = true
  let attachments = <MimeiFileType[]>[]
  try {
    console.log('[TWEET-SUBMIT] File uploads to process:', filesUpload.value.length);
    console.log('[TWEET-SUBMIT] CID modal files:', mmFiles.value.length);
    
    if (filesUpload.value.length > 0) {
      console.log('[TWEET-SUBMIT] Processing file uploads...');
      // with attachments to be uploaded
      // reopen the DB mimei as cur version, for writing
      attachments = (await uploadAttachedFiles(filesUpload.value))
        .filter((v) => { return v.status === 'fulfilled' })
        .map((v: any) => {
          return v.value    // get FileInfo of each attachment
        })
      console.log('[TWEET-SUBMIT] File uploads completed:', attachments.length);
      if (attachments?.length < filesUpload.value.length) {
        // uploading files failed
        throw 'Attachments uploading failed' + attachments.toString()
      }
    }
    
    // upload tweet
    let tweet = {
      authorId: tweetStore.loginUser!.mid,  // Safe: we validated loginUser exists above
      title: tweetTitle.value,
      content: txtConent.value,
      attachments: attachments.concat(mmFiles.value),
      isPrivate: isPrivate.value,
      downloadable: downloadable.value,
      timestamp: Date.now()
    }
    
    console.log('[TWEET-SUBMIT] Tweet object created:', {
      authorId: tweet.authorId,
      title: tweet.title,
      contentLength: tweet.content?.length || 0,
      totalAttachments: tweet.attachments.length,
      uploadedAttachments: attachments.length,
      cidModalAttachments: mmFiles.value.length,
      isPrivate: tweet.isPrivate,
      downloadable: tweet.downloadable
    });
    
    console.log('[TWEET-SUBMIT] CID modal attachments details:', mmFiles.value.map(f => ({
      fileName: f.fileName,
      mid: f.mid,
      type: f.type,
      size: f.size
    })));
    
    const targetTweetId = tweetId.value as MimeiId
    console.log('[TWEET-SUBMIT] Calling tweetStore.uploadTweet...', { targetTweetId });
    const result = await tweetStore.uploadTweet(tweet, targetTweetId)
    
    // Check if tweet upload was successful
    console.log('[TWEET-SUBMIT] Tweet upload result:', result);
    if (result) {
      console.log('[TWEET-SUBMIT] Tweet upload successful!');
      useAlertStore().success("Tweet uploaded successfully!")
      
      // Clear form only on success
      txtConent.value = null
      tweetTitle.value = null
      filesUpload.value = []
      mmFiles.value = []
      noResample.value = false
      
      // If this was a comment (tweetId exists), navigate back to parent tweet's detail view
      if (targetTweetId) {
        try {
          const parentTweet = await tweetStore.getTweet(targetTweetId)
          if (parentTweet && parentTweet.author) {
            console.log('[TWEET-SUBMIT] Navigating back to parent tweet:', targetTweetId, parentTweet.author.mid)
            router.push({ 
              name: 'TweetDetail', 
              params: { 
                tweetId: targetTweetId, 
                authorId: parentTweet.author.mid 
              } 
            })
          } else {
            // Fallback: navigate to parent tweet without authorId
            console.log('[TWEET-SUBMIT] Parent tweet not found, navigating without authorId')
            router.push({ 
              name: 'TweetDetail', 
              params: { 
                tweetId: targetTweetId 
              } 
            })
          }
        } catch (error) {
          console.error('[TWEET-SUBMIT] Error fetching parent tweet for navigation:', error)
          // Fallback: navigate to parent tweet without authorId
          router.push({ 
            name: 'TweetDetail', 
            params: { 
              tweetId: targetTweetId 
            } 
          })
        }
      } else {
        // This was a new tweet, emit success event
        emit('uploaded', result)
        emit('hide')
      }
    } else {
      console.log('[TWEET-SUBMIT] Tweet upload failed: No response from server');
      throw new Error("Tweet upload failed: No response from server")
    }
    
  } catch (err) {
    // something wrong uploading files or tweet, show error
    console.error('[TWEET-SUBMIT] Error occurred:', err);
    console.error('onSubmit err:', err)
    useAlertStore().error(err instanceof Error ? err.message : String(err))
  } finally {
    console.log('[TWEET-SUBMIT] Submission process completed, setting loading to false');
    loading.value = false
  }
}

// Upload file using upload_ipfs API (matches iOS implementation)
async function uploadFileToIPFS(
  data: ArrayBuffer,
  fileIndex: number,
  fileName: string
): Promise<string> {
  console.log(`[UPLOAD] Starting upload for ${fileName} (${(data.byteLength / 1024 / 1024).toFixed(2)}MB)`)
  
  const chunkSize = 1024 * 1024 // 1MB chunks to match iOS
  let offset = 0
  let fsid: string | null = null
  let chunkNumber = 0
  
  // Get a direct connection for uploads to avoid connection pool timeout
  // File uploads are long-running and shouldn't use the shared pool
  const providerIp = tweetStore.loginUser?.providerIp
  if (!providerIp) {
    throw new Error('Provider IP not available')
  }
  
  const uploadClient = await tweetStore.lapi.connectionPool.getConnection(providerIp)
  
  try {
    // Set a longer timeout for file uploads (10 minutes)
    uploadClient.timeout = 10 * 60 * 1000
    
    while (offset < data.byteLength) {
      const end = Math.min(offset + chunkSize, data.byteLength)
      const chunk = data.slice(offset, end)
      chunkNumber++
      
      // Build request object (matches iOS structure)
      const request: any = {
        aid: tweetStore.appId,
        ver: 'last',
        version: 'v2',
        offset: offset
      }
      
      if (fsid) {
        request.fsid = fsid
      }
      
      // Mark as finished on last chunk
      if (end === data.byteLength) {
        request.finished = 'true'
      }
      
      console.log(`[UPLOAD] Uploading chunk ${chunkNumber} for ${fileName}: ${((offset / data.byteLength) * 100).toFixed(1)}%`)
      
      // Call upload_ipfs API directly (matches iOS implementation)
      const response = await uploadClient.RunMApp('upload_ipfs', request, [new Uint8Array(chunk)])
      
      // Update progress
      uploadProgress[fileIndex] = Math.floor((end / data.byteLength) * 100)
      
      // Handle v2 response format: {success: true, data: fsid|cid} or {success: false, message: string}
      if (response && typeof response === 'object') {
        if (response.success === false) {
          throw new Error(response.message || 'Upload failed')
        }
        
        if (response.success === true && response.data) {
          fsid = response.data
          offset = end
        } else {
          throw new Error(`Invalid response structure: ${JSON.stringify(response)}`)
        }
      } else if (typeof response === 'string') {
        // Handle non-v2 response (direct string)
        fsid = response
        offset = end
      } else {
        throw new Error(`Unexpected response type: ${typeof response}`)
      }
    }
    
    if (!fsid) {
      throw new Error('No file ID returned from server')
    }
    
    uploadProgress[fileIndex] = 100
    console.log(`[UPLOAD] Upload completed for ${fileName}, CID: ${fsid}`)
    return fsid
    
  } catch (error) {
    console.error(`[UPLOAD] Error uploading ${fileName}:`, error)
    throw error
  } finally {
    // Always release the connection back to the pool
    if (providerIp) {
      tweetStore.lapi.connectionPool.releaseConnection(providerIp, uploadClient)
      console.log(`[UPLOAD] Released connection for ${fileName}`)
    }
  }
}

// Check if the cloud drive service is available at the specified URL
async function checkServiceAvailability(baseUrl: string): Promise<boolean> {
  try {
    console.log(`Checking service availability at: ${baseUrl}/health`);
    
    // Try to make a health check request with a reasonable timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout for slow networks
    
    const response = await fetch(`${baseUrl}/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
      }
    }).catch((error) => {
      console.warn(`Health check fetch failed: ${error.message}`);
      return null;
    });
    
    clearTimeout(timeoutId);
    
    // Service must return a successful response with JSON
    if (response && response.ok) {
      try {
        const data = await response.json();
        // Validate that the response has the expected structure
        if (data && data.status === 'ok') {
          console.log(`Service availability check: AVAILABLE (status: ${data.status}, timestamp: ${data.timestamp})`);
          return true;
        } else {
          console.warn(`Service availability check: Invalid health response format:`, data);
          return false;
        }
      } catch (jsonError) {
        console.warn(`Service availability check: Failed to parse JSON response:`, jsonError);
        return false;
      }
    }
    
    console.warn(`Service availability check: NOT AVAILABLE (status: ${response?.status || 'no response'})`);
    return false;
  } catch (error) {
    console.warn(`Service availability check: ERROR - ${error}`);
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
        useAlertStore().error("Total upload size exceeds 4GB limit.");
        return; // Stop adding files
      }

      // Assign a title if it's not already set
      if (!tweetTitle.value && !txtConent.value) {
        tweetTitle.value = file.name;
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

function removeFile(f: File) {
  // removed file from preview list
  var i = filesUpload.value.findIndex((e: File) => e == f)
  filesUpload.value.splice(i, 1)
}

function logout() {
  tweetStore.logout();
  location.reload()
}

const handleCids = (ids: MimeiFileType[]) => {
  mmFiles.value = ids;
  showCidModal.value = false;
  if (ids.length > 0) {
    divAttach.value.hidden = false
    if (!tweetTitle.value && !txtConent.value) {
      tweetTitle.value = ids[0].fileName;
    }
  }
};
const cancelCidsModal = () => {
  showCidModal.value = false;
  console.log('Modal cancelled');
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

  <div class='row justify-content-start align-items-start'>
    <div class='col-sm-12 col-md-10 col-lg-8' style='background-color:aliceblue;'>
      <div class='card-header d-flex align-items-center'>
        <ItemHeader :author='author'></ItemHeader>
        <button class='logout' @click.prevent='logout'>Logout</button>
      </div>
      <div class='modal-content' @dragover.prevent='dragOver' @drop.prevent='onSelect'>
        <div>
          <input type='text' placeholder='Title...' v-model='tweetTitle' class='input-caption' />
        </div>
        <div class='input-container'>
          <textarea ref='textArea' v-model='txtConent' placeholder='Input......' class='input-textarea'></textarea>
          <div ref='dropHere' hidden class='drop-here'>
            <p>DROP HERE</p>
          </div>
        </div>
        <form @submit.prevent='onSubmit' enctype='multipart/form-data' @paste.prevent='onSelect' class='form-container'>
          <input ref='selectFiles' @change='onSelect' type='file' hidden multiple />
          <div class='button-container'>
            <span>
              <button class='btn' @click.prevent='selectFiles.click()'>Files</button>&nbsp;
              <label class="bottom-btn" @click.prevent="openModal">
                <IconLink />
              </label>
            </span>
            <span>
              <input type='checkbox' v-model='downloadable' id='downloadable-checkbox'>&nbsp;
              <label for='downloadable-checkbox'>Downloadable</label>&nbsp;&nbsp;&nbsp;
              <input type='checkbox' v-model='isPrivate' id='private-checkbox'>&nbsp;
              <label for='private-checkbox'>Private</label>&nbsp;&nbsp;&nbsp;
              <input type='checkbox' v-model='noResample' id='noresample-checkbox'>&nbsp;
              <label for='noresample-checkbox' title='Preserve original video quality without resampling (larger file size)'>Preserve Quality</label>&nbsp;&nbsp;&nbsp;
              <button class='btn' type='submit'>Submit</button>
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
  </div>
</template>

<style scoped>
.input-caption {
  border: 0px;
  width: 98%;
  margin: 8px 8px 8px 8px;
}

.card-header {
  margin-left: 10px;
  display: flex;
  align-items: center;
}

.logout {
  border-radius: 5px;
  border: 1px solid rgb(143, 139, 139);
  padding: 3px 10px;
  margin-left: auto;
}

.modal-content {
  width: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  background-color: #ebf0f3;
  border: 1px solid #888;
  margin: 10px 0 0 10px;
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