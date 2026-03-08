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
const isAppPackage = ref(true)
const isMini = ref(false)

onMounted(() => {
})
// Helper function to handle individual file uploads using new upload_ipfs API
async function uploadFile(file: File, index: number = 0): Promise<string> {
    if (file.size > sliceSize * 300) {
        throw new Error('Max file size exceeded')
    }
    
    // Assign initial progress value
    uploadProgress[index] = 0

    // Get a dedicated connection for uploads to avoid connection pool timeout
    const providerIp = tweetStore.loginUser?.providerIp
    if (!providerIp) {
        throw new Error('Provider IP not available')
    }
    
    const uploadClient = await tweetStore.lapi.connectionPool.getConnection(providerIp)
    
    try {
        // Set 10 minute timeout for large file uploads (matches EditorModal)
        uploadClient.timeout = 10 * 60 * 1000
        
        // Upload using new upload_ipfs API
        const mid = await uploadFileWithNewAPI(file, index, uploadClient)
        return mid
    } finally {
        // Always release the connection back to the pool
        tweetStore.lapi.connectionPool.releaseConnection(providerIp, uploadClient)
        console.log(`[UPLOAD-PACKAGE] Released connection for ${file.name}`)
    }
}

// Upload file using upload_ipfs API (matches EditorModal implementation)
async function uploadFileWithNewAPI(
    file: File,
    index: number,
    uploadClient: any
): Promise<string> {
    const data = await file.arrayBuffer()
    const chunkSize = 1024 * 1024 // 1MB chunks
    let offset = 0
    let fsid: string | null = null
    let chunkNumber = 0
    
    console.log(`[UPLOAD-PACKAGE] Starting upload for ${file.name} (${(data.byteLength / 1024 / 1024).toFixed(2)}MB)`)
    
    while (offset < data.byteLength) {
        const end = Math.min(offset + chunkSize, data.byteLength)
        const chunk = data.slice(offset, end)
        chunkNumber++
        
        // Build request object
        const request: any = {
            aid: tweetStore.appId,
            ver: 'last',
            version: 'v2',
            offset: offset
        }
        
        if (fsid) {
            request.fsid = fsid
        }
        
        // NOTE: Do NOT set finished='true' here - that's done in a separate finalization request (matches iOS)
        
        console.log(`[UPLOAD-PACKAGE] Uploading chunk ${chunkNumber} for ${file.name}: ${((offset / data.byteLength) * 100).toFixed(1)}%`)
        
        // Call upload_ipfs API
        const response = await uploadClient.RunMApp('upload_ipfs', request, [new Uint8Array(chunk)])
        
        // Update progress
        uploadProgress[index] = Math.floor((end / data.byteLength) * 100)
        
        // Handle v2 response format
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
    
    // Send finalization request (matches iOS - separate request with finished='true')
    console.log(`[UPLOAD-PACKAGE] Uploaded ${chunkNumber} chunks, finalizing...`)
    const finalRequest: any = {
        aid: tweetStore.appId,
        ver: 'last',
        version: 'v2',
        offset: offset,
        fsid: fsid,
        finished: 'true'
    }
    
    const finalResponse = await uploadClient.RunMApp('upload_ipfs', finalRequest)
    
    // Parse finalization response
    let cid: string | null = null
    if (finalResponse && typeof finalResponse === 'object') {
        if (finalResponse.success === true && finalResponse.data) {
            cid = finalResponse.data
        } else if (finalResponse.cid) {
            cid = finalResponse.cid
        }
    } else if (typeof finalResponse === 'string') {
        cid = finalResponse
    }
    
    if (!cid) {
        throw new Error('No CID returned from finalization')
    }
    
    uploadProgress[index] = 100
    console.log(`[UPLOAD-PACKAGE] Upload completed for ${file.name}, CID: ${cid}`)
    
    // Handle package upload (same as before)
    if (isAppPackage.value) {
        return await tweetStore.uploadPackage(cid, isMini.value)
    } else {
        return await tweetStore.uploadFile(cid, file.name)
    }
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
<div class="row justify-content-start align-items-start">
    <div class="col-sm-12 col-md-8 col-lg-6" style="background-color:aliceblue;">
    <div class="card-header d-flex align-items-center">
        <input v-model="isAppPackage" type="checkbox" unchecked>&nbsp;Upload App package</input>
        <input v-model="isMini" type="checkbox" unchecked style="margin-left: 15px;">&nbsp;Mini</input>
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
</div>
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
