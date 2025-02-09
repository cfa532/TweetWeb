<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { Loading, Preview } from '@/views'
import { useTweetStore, useAlertStore } from '@/stores'

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
const tweetStore = useTweetStore()
const hproseClient = tweetStore.loginUser?.client
const isAppPackage = ref(true)

onMounted(() => {
})
// Helper function to handle individual file uploads
async function uploadFile(file: File, index: number = 0): Promise<string> {
    if (file.size > sliceSize * 300) {
        throw new Error('Max file size exceeded')
    }
    // Assign initial progress value
    uploadProgress[index] = 0

    // Create a FileInfo object with file name, last modified time,
    const fsid = await tweetStore.openTempFile()
    let mid = await readFileSlice(fsid, await file.arrayBuffer(), 0, index) // return an IPFS cid
    return mid
}

async function onSubmit() {
    loading.value = true
    try {
        if (filesUpload.value.length < 1)
            return
        let mid = await uploadFile(filesUpload.value[0])
        console.log('Package mid:', mid)
        textValue.value = ""
        filesUpload.value = []
        useAlertStore().success("App package mimei: " + mid)
    } catch (err) {
        // something wrong uploading files, abort
        console.error('onSubmit err:', err)
        useAlertStore().error(err)
    } finally {
        loading.value = false
    }
}

// upload file to Mimei database and return a IPFS cid.
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
        const t = hproseClient.timeout
        hproseClient.timeout = 0      // do Not timeout
        const cid = await hproseClient.MFTemp2Ipfs(fsid)
        console.log("file cid=", cid)
        hproseClient.timeout = t
        if (isAppPackage.value)
            // upload app installation package.
            return await tweetStore.uploadPackage(cid)
        else
            return await tweetStore.uploadFile(cid, filesUpload.value[0].name)
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
</script>

<template>
    <div class="card-header d-flex align-items-center">
        <input v-model="isAppPackage" type="checkbox" unchecked>&nbsp;Upload App package</input>
    </div>
    <div class="modal-content" @dragover.prevent="dragOver" @drop.prevent="onSelect">
        <div class="input-container">
            <textarea ref="textArea" v-model="textValue" placeholder="Input......" class="input-textarea"></textarea>
            <div ref="dropHere" hidden class="drop-here">
                <p>DROP HERE</p>
            </div>
        </div>
        <form @submit.prevent="onSubmit" enctype="multipart/form-data" @paste.prevent="onSelect" class="form-container">
            <input ref="selectFiles" @change="onSelect" type="file" hidden multiple />
            <div class="button-container">
                <button class="btn" @click.prevent="selectFiles.click()">Choose</button>
                <button class="btn" type="submit">Submit</button>
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
    height: 20vh;
    border-radius: 5px;
}

.drop-here {
    border: 1px solid lightgrey;
    width: 100%;
    height: 200px;
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
