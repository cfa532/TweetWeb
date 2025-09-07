<script setup lang='ts'>
import { ref, reactive, onMounted } from 'vue'
import { Loading, Preview, ItemHeader, CidPreview } from '@/views'
import { useTweetStore, useAlertStore } from '@/stores'
import { useRoute } from 'vue-router';
import IconLink from '@/components/icons/IconLink.vue'
import { CidModal } from '@/views'
import { compressImage, uploadVideo, getVideoAspectRatio, getImageAspectRatio, getMediaType } from '@/utils/uploadUtils'

interface HTMLInputEvent extends Event {
  target: HTMLInputElement & EventTarget
}
const emit = defineEmits(['uploaded', 'hide'])
const tweetId = useRoute().params.tweetId
const tweetTitle = ref()
const txtConent = ref()
const divAttach = ref()
const dropHere = ref()
const textArea = ref<HTMLTextAreaElement>()
const sliceSize = 1024 * 1024 * 10 // 10MB per slice of file
const filesUpload = ref<File[]>([])
const uploadProgress = reactive<number[]>([])    // upload progress of each file
const loading = ref(false)
const selectFiles = ref()
const isPrivate = ref(false)
const downloadable = ref(true)  // whether the attachment is downloadable
const noResample = ref(false)   // whether to preserve original video quality
const tweetStore = useTweetStore()
const hproseClient = tweetStore.loginUser?.client
const tweet = ref<Tweet>()
const author = tweetStore.loginUser!  // the page is accessible only by login user.
const mmFiles = ref<MimeiFileType[]>([]);
const showCidModal = ref(false);

const MAX_UPLOAD_SIZE = 4 * 1024 * 1024 * 1024; // 4GB

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

      const fileType = getMediaType(file.type);
      let processedFile = file;
      let cid: string;

      // Handle different file types
      if (fileType === 'Image') {
        // Compress image to under 2MB
        processedFile = await compressImage(file);
        uploadProgress[i] = 50; // Show progress for compression
        
        // Upload compressed image using existing method
        const fsid = await tweetStore.openTempFile();
        const defaultTimeout = hproseClient.timeout;
        hproseClient.timeout = 0;
        cid = await readFileSlice(fsid, await processedFile.arrayBuffer(), 0, i);
        hproseClient.timeout = defaultTimeout;
        
      } else if (fileType === 'Video') {
        // Upload video through new endpoint
        uploadProgress[i] = 5; // Show initial progress
        
        // Validate required parameters
        if (!author.providerIp) {
          throw new Error('Provider IP is not available for video upload');
        }
        
        const cloudDrivePort = author.cloudDrivePort?.toString() || '8010';
        
        // Extract IP address from providerIp (which might include a port)
        let ipAddress = author.providerIp;
        if (ipAddress.includes(':')) {
          // Remove port from providerIp if it exists
          ipAddress = ipAddress.split(':')[0];
        }
        
        console.log('Video upload parameters:', {
          originalProviderIp: author.providerIp,
          extractedIpAddress: ipAddress,
          cloudDrivePort: cloudDrivePort,
          noResample: noResample.value
        });
        
        // Construct baseUrl using extracted IP and cloudDrivePort
        const baseUrl = `http://${ipAddress}:${cloudDrivePort}`;
        
        // Always use regular multipart upload for videos
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
        
        uploadProgress[i] = 100; // Complete
        
      } else {
        // Handle other file types with existing method
        const fsid = await tweetStore.openTempFile();
        const defaultTimeout = hproseClient.timeout;
        hproseClient.timeout = 0;
        cid = await readFileSlice(fsid, await processedFile.arrayBuffer(), 0, i);
        hproseClient.timeout = defaultTimeout;
      }

      const aspectRatio = fileType === 'Video' ? await getVideoAspectRatio(file) : 
                         fileType === 'Image' ? await getImageAspectRatio(file) : null;
      const fi = {
        mid: cid,
        type: fileType === 'Video' ? 'hls_video' : fileType,  // all videos are converted to hls_video
        size: processedFile.size,
        fileName: file.name,
        timestamp: file.lastModified,
        aspectRatio: aspectRatio
      } as MimeiFileType;

      console.log(fi);
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
        finalErrorMessage = `File ${file.name} is too large. Maximum size is 1GB.`;
      } else if (errorMessage.includes('No CID returned')) {
        finalErrorMessage = `Video processing failed for ${file.name}. Please try again.`;
      }
      
      results.push({ status: 'rejected', reason: new Error(finalErrorMessage) });
    }
  }

  return results;
}

async function onSubmit() {
  loading.value = true
  let attachments = <MimeiFileType[]>[]
  try {
    if (filesUpload.value.length > 0) {
      // with attachments to be uploaded
      // reopen the DB mimei as cur version, for writing
      attachments = (await uploadAttachedFiles(filesUpload.value))
        .filter((v) => { return v.status === 'fulfilled' })
        .map((v: any) => {
          return v.value    // get FileInfo of each attachment
        })
      if (attachments?.length < filesUpload.value.length) {
        // uploading files failed
        throw 'Attachments uploading failed' + attachments.toString()
      }
    }
    // upload tweet
    let tweet = {
      authorId: tweetStore.loginUser?.mid,
      title: tweetTitle.value,
      content: txtConent.value,
      attachments: attachments.concat(mmFiles.value),
      isPrivate: isPrivate.value,
      downloadable: downloadable.value,
      timestamp: Date.now()
    }
    
    const result = await tweetStore.uploadTweet(tweet, tweetId as MimeiId)
    
    // Check if tweet upload was successful
    if (result) {
      useAlertStore().success("Tweet uploaded successfully!")
      
      // Clear form only on success
      txtConent.value = null
      tweetTitle.value = null
      filesUpload.value = []
      mmFiles.value = []
      noResample.value = false
      
      // Emit success event and hide modal
      emit('uploaded', result)
      emit('hide')
    } else {
      throw new Error("Tweet upload failed: No response from server")
    }
    
  } catch (err) {
    // something wrong uploading files or tweet, show error
    console.error('onSubmit err:', err)
    useAlertStore().error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function readFileSlice(
  fsid: string,
  arr: ArrayBuffer,
  start: number,
  index: number
): Promise<string> {
  // reading file slice by slice, start at given position
  var end = Math.min(start + sliceSize, arr.byteLength)
  let count = await hproseClient.MFSetData(fsid, arr.slice(start, end), start)
  // Calculate progress
  uploadProgress[index] = Math.floor(((start + count) / arr.byteLength) * 100)
  console.log('Uploading...', uploadProgress[index] + '%', end, arr.byteLength)

  if (end === arr.byteLength) {
    // last slice read. Convert temp to IPFS file
    const cid = await hproseClient.MFTemp2Ipfs(fsid)
    return cid
  } else {
    // recursive call
    return await readFileSlice(fsid, arr, start + count, index)
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
        <Preview @file-canceled='removeFile(file)' v-for='(file, index) in filesUpload' :key='index' v-bind:src='file'
          v-bind:progress='uploadProgress[index]'></Preview>
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