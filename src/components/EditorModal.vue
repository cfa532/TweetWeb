<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { Loading, Preview, ItemHeader } from '@/views'
import { useTweetStore, useLeitherStore } from '@/stores'

interface HTMLInputEvent extends Event {
  target: HTMLInputElement & EventTarget
}
const emit = defineEmits(['uploaded', 'hide'])
const tweetTitle = ref()
const txtConent = ref()
const divAttach = ref()
const dropHere = ref()
const textArea = ref<HTMLTextAreaElement>()
const sliceSize = 1024 * 1024 * 1 // 10MB per slice of file
const filesUpload = ref<File[]>([])
const uploadProgress = reactive<number[]>([])    // upload progress of each file
const loading = ref(false)
const selectFiles = ref()
const isPrivate = ref(false)
const downloadable = ref(true)
const api = useLeitherStore()
const tweetStore = useTweetStore()
const tweet = ref<Tweet>()
const author = tweetStore.loginUser!  // the page is accessible only by login user.

onMounted(() => {
  tweet.value = { mid: "dfdfd", authorId: author.mid, author: author, timestamp: Date.now() }
})

// Upload files and store them as IPFS or Mimei type
async function uploadAttachedFiles(files: File[]): Promise<PromiseSettledResult<MimeiFileType>[]> {
  
  function getMedaiType(t: string) {
    if (t.startsWith("image/")) return "Image"
    if (t.startsWith("video/")) return "Video"
    if (t.startsWith("audio/")) return "Audio"
    return "Uknown"
  }

  // Helper function to handle individual file uploads
  async function uploadSingleFile(file: File, index: number): Promise<MimeiFileType> {
    if (file.size > sliceSize * 300) {
      throw new Error('Max file size exceeded')
    }
    // Assign initial progress value
    uploadProgress[index] = 0

    // Create a FileInfo object with file name, last modified time,
    const fsid = await tweetStore.openTempFile()
    const fi = { mid: "", type: getMedaiType(file.type), size: file.size, fileName: file.name, timestamp: file.lastModified } as MimeiFileType

    const t = api.client.timeout
    api.client.timeout = 0    // never timeout
    fi.mid = await readFileSlice(fsid, await file.arrayBuffer(), 0, index) // returned an IPFS id actually
    api.client.timeout = t    // restore default timeout
    console.log(fi) // never executed when there is a timeout uploading file.
    return fi
  }

  // Use Promise.allSettled to wait for all file upload operations to complete
  return Promise.allSettled(files.map((file, i) => uploadSingleFile(file, i)))
}

async function onSubmit() {
  loading.value = true
  let attachments = null
  try {
    if (filesUpload.value.length > 0) {
      // with attachments to be uploaded
      // reopen the DB mimei as cur version, for writing
      attachments = (await uploadAttachedFiles(filesUpload.value))
        .filter((v) => { return v.status === 'fulfilled' })
        .map((v: any) => {
          return v.value    // get FileInfo of each attachment
        })
      if (!attachments || attachments.length < filesUpload.value.length) {
        // uploading files failed
        throw 'Attachments uploading failed' + attachments.toString()
      }
    }
    // upload tweet
    let tweet = {
      title: tweetTitle.value,
      content: txtConent.value,
      attachments: attachments as MimeiFileType[],
      isPrivate: isPrivate.value,
      downloadable: downloadable.value,
      timestamp: Date.now()
    }
    await tweetStore.uploadTweet(tweet)
    txtConent.value = null
    tweetTitle.value = null
    filesUpload.value = []
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
    const cid = await api.client.MFTemp2Ipfs(fsid)
    api.client.timeout = t
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
    // Assign a title if it's not already set
    if (!tweetTitle.value && !txtConent.value) {
      tweetTitle.value = files[0].name;
    }

    // Remove duplication and add files to the upload list
    Array.from(files).forEach((f) => {
      if (
        filesUpload.value.findIndex((e: File) => {
          return e.size === f.size && e.name === f.name
        }) === -1
      ) {
        filesUpload.value.push(f)
      }
    });

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
</script>

<template>
  <div class="card-header d-flex align-items-center">
    <ItemHeader :author="author"></ItemHeader>
    <button class="logout" @click.prevent="logout">Logout</button>
  </div>
  <div class="modal-content" @dragover.prevent="dragOver" @drop.prevent="onSelect">
    <div>
      <input type="text" placeholder="Title..." v-model="tweetTitle" class="input-caption" />
    </div>
    <div class="input-container">
      <textarea ref="textArea" v-model="txtConent" placeholder="Input......" class="input-textarea"></textarea>
      <div ref="dropHere" hidden class="drop-here">
        <p>DROP HERE</p>
      </div>
    </div>
    <form @submit.prevent="onSubmit" enctype="multipart/form-data" @paste.prevent="onSelect" class="form-container">
      <input ref="selectFiles" @change="onSelect" type="file" hidden multiple />
      <div class="button-container">
        <button class="btn" @click.prevent="selectFiles.click()">Choose</button>
        <span>
          <input type="checkbox" v-model="downloadable" id="checkbox">&nbsp;
          <label for="checkbox">Downloadable</label>&nbsp;&nbsp;&nbsp;
          <input type="checkbox" v-model="isPrivate" id="checkbox">&nbsp;
          <label for="checkbox">Private</label>&nbsp;&nbsp;&nbsp;
          <button class="btn" type="submit">Submit</button>
        </span>
      </div>
      <Loading :visible="loading" />
    </form>
  </div>
  <div ref="divAttach" hidden class="preview-container">
    <Preview @file-canceled="removeFile(file)" v-for="(file, index) in filesUpload" :key="index" v-bind:src="file"
      v-bind:progress="uploadProgress[index]"></Preview>
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
</style>
