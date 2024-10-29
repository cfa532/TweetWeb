<script setup lang="ts">
import { ref, reactive, watch } from 'vue'
import { Loading, Preview } from '@/views'
import { useTweetStore } from '@/stores/tweetStore'
import { useLeitherStore } from '@/stores/leitherStore';

interface HTMLInputEvent extends Event {
  target: HTMLInputElement & EventTarget
}
const emit = defineEmits(['uploaded', 'hide'])
const inpCaption = ref()
const textValue = ref('')
const divAttach = ref()
const dropHere = ref()
const textArea = ref<HTMLTextAreaElement>()
const sliceSize = 1024 * 1024 * 10 // 10MB per slice of file
const filesUpload = ref<File[]>([])
const uploadProgress = reactive<number[]>([]) // New ref to store upload progress of each file
const loading = ref(false)
const selectFiles = ref()
const api = useLeitherStore()
const tweetStore = useTweetStore()

// Upload files and store them as IPFS or Mimei type
async function uploadFile(files: File[]): Promise<PromiseSettledResult<MimeiFileType>[]> {
  // Helper function to handle individual file uploads
  async function uploadSingleFile(file: File, index: number): Promise<MimeiFileType> {
    // Check if the file size exceeds the limit (200MB in this example)
    if (file.size > sliceSize * 300) {
      throw new Error('Max file size exceeded')
    }
    // Assign initial progress value
    uploadProgress[index] = 0

    // Create a FileInfo object with file name, last modified time,
    const fsid = await api.client.MFOpenTempFile(api.sid)
    const fi = {mid: "", type: file.type, size: file.size} as MimeiFileType
    fi.mid = await readFileSlice(fsid, await file.arrayBuffer(), 0, index) // return an IPFS id actually
    console.log(fi) // never executed when there is a timeout uploading file.
    return fi
  }
  // Use Promise.allSettled to wait for all file upload operations to complete
  return Promise.allSettled(files.map((file, i) => uploadSingleFile(file, i)))
}

async function onSubmit() {
  loading.value = true
  try {
    if (filesUpload.value.length > 0) {
      // with attachments to be uploaded
      // reopen the DB mimei as cur version, for writing
      let attachments = (await uploadFile(filesUpload.value))
        .filter((v) => { return v.status === 'fulfilled' })
        .map((v: any) => {
          return v.value    // get FileInfo of each attachment
        })
      if (!attachments || attachments.length < filesUpload.value.length) {
        // uploading files failed
        throw 'Attachments uploading failed' + attachments.toString()
      }
      // upload tweet
      // api.client.RunMApp("")
      let tweet = {content: textValue.value, attachments: attachments, isPrivate: false,
        timestamp: Date.now()
      }
      tweetStore.uploadTweet(tweet)
    }
  } catch (err) {
    // something wrong uploading files, abort
    console.error('onSubmit err:', err)
    window.alert(err)
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
  let count = await api.client.MFSetData(fsid, arr.slice(start, end), start)
  // Calculate progress
  uploadProgress[index] = Math.floor(((start + count) / arr.byteLength) * 100)
  console.log('Uploading...', uploadProgress[index] + '%', end, arr.byteLength)

  if (end === arr.byteLength) {
    // last slice read. Convert temp to IPFS file
    const t = api.client.timeout
    api.client.timeout = 0
    const mid =  await api.client.MFTemp2Ipfs(fsid)
    api.client.timeout = t
    return mid
  } else {
    return await readFileSlice(fsid, arr, start + count, index)
  }
}
async function onSelect(e: Event) {
  const files =
    (e as HTMLInputEvent).target.files ||       // select input file
    (e as DragEvent).dataTransfer?.files ||     // drag and drop
    (e as ClipboardEvent).clipboardData?.files  // copy and paste
  if (files?.length! > 0) {
    Array.from(files!).forEach((f) => {
      if (
        filesUpload.value.findIndex((e: File) => {
          return e.size === f.size && e.name === f.name
        }) === -1
      ) {
        // remove duplication
        if (!inpCaption.value || inpCaption.value.trim() === '') {
          inpCaption.value = f.name
        }
        filesUpload.value.push(f)
      }
    })
    divAttach.value!.hidden = false
    textArea.value!.hidden = false
    dropHere.value!.hidden = true
  } else {
    // clipboard works only with HTTPS
    // const t = await navigator.clipboard.readText()
    if ((e.target as HTMLTextAreaElement) === textArea.value) {
      // paste into text area
      document.execCommand('paste')
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
watch(
  () => textValue.value,
  (newVal, oldVal) => {
    if (newVal !== oldVal) {
      localStorage.setItem('tempTextValueUploader', newVal)
    }
  }
)
</script>

<template>
  <div class="modal-content" @dragover.prevent="dragOver" @drop.prevent="onSelect">
    <div class="content-wrapper">
      <div class="input-container">
        <textarea ref="textArea" v-model="textValue" placeholder="Input......" class="input-textarea"></textarea>
        <div ref="dropHere" hidden class="drop-here">
          <p>DROP HERE</p>
        </div>
      </div>
      <form @submit.prevent="onSubmit" enctype="multipart/form-data" @paste.prevent="onSelect" class="form-container">
        <div ref="divAttach" hidden class="preview-container">
          <Preview @file-canceled="removeFile(file)" v-for="(file, index) in filesUpload" :key="index" v-bind:src="file"
          v-bind:progress="uploadProgress[index]"></Preview>
        </div>
        <input ref="selectFiles" @change="onSelect" type="file" hidden multiple />
        <div class="button-container">
          <button @click.prevent="selectFiles.click()">Choose</button>
          <button type="submit">Submit</button>
        </div>
        <Loading :visible="loading" />
      </form>
    </div>
  </div>
</template>

<style scoped>
.modal-content {
  width: 100%;
  position: relative;
  display: flex;
  flex-direction: column;
  border-radius: 5px;
  background-color: #ebf0f3;
  padding: 10px;
  border: 1px solid #888;
  height: 60vh;
  margin: 10px 0 0 10px;
}

.content-wrapper {
  display: flex;
  flex-direction: column;
  flex: 1;
}

.input-container {
  flex: 1;
  margin-bottom: 10px;
  display: inline;
}
.input-title {
  border: 0px;
  height: 30px;
  margin-bottom: 8px;
}
.input-caption {
  border: 0px;
  width: 70%;
  height: 30px;
  margin-bottom: 8px;
}

.input-textarea {
  margin: 5px;
  position: absolute;
  top: 50px;
  left: 0;
  bottom: 60px;
  /* height: 150%; */
  border: 1px solid lightgrey;
  width: 99%;
  border-radius: 3px;
}

.drop-here {
  border: 1px solid lightgrey;
  width: 100%;
  height: 200px;
  margin: 0px;
  text-align: center;
}

.form-container {
  display: flex;
  flex-direction: column;
  flex: 1;
  height: 10px;
}

.preview-container {
  margin: 10px;
  position: absolute;
  left: 0;
  bottom: 50px;
  border: 0px solid lightgray;
  border-radius: 5px;
  margin-bottom: 6px;
  padding-top: 0px;
}

.button-container {
  height: auto;
  display: flex;
  justify-content: space-between;
  margin-top: auto;
}
</style>
