<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue'
import { Loading, Preview } from '@/views'
import { useTweetStore, useAlertStore } from '@/stores'
import * as tus from 'tus-js-client';
import axios from 'axios'; // Import axios

interface HTMLInputEvent extends Event {
    target: HTMLInputElement & EventTarget
}
const tusServerUrl = import.meta.env.VITE_TUS_SERVER
const emit = defineEmits(['uploaded', 'hide'])
const inpCaption = ref()
const textValue = ref('')
const divAttach = ref()
const dropHere = ref()
const textArea = ref<HTMLTextAreaElement>()
const sliceSize = 1024 * 1024 * 10 // 10MB per slice of file
const filesUpload = ref<File[]>([])
const uploadProgress = reactive<number[]>([]) // Store upload progress of each file
const loading = ref(false)
const selectFiles = ref()
const tweetStore = useTweetStore()
const alertStore = useAlertStore()
const hproseClient = tweetStore.loginUser?.client
const isResumableUpload = ref(true)
const uploads = ref<any[]>([]) // Store tus upload instances

onMounted(() => {
    // Check if there are any uploads in progress from localStorage
    const storedUploads = localStorage.getItem('resumableUploads')
    if (storedUploads) {
        try {
            const uploadData = JSON.parse(storedUploads)
            // We could potentially restore uploads here, but would need file objects
            // which aren't serializable to localStorage
        } catch (e) {
            console.error('Failed to parse stored uploads', e)
        }
    }
})

// Helper function to handle individual file uploads with tus
async function uploadFileWithTus(file: File, index: number = 0): Promise<string> {
    return new Promise((resolve, reject) => {
        if (file.size > sliceSize * 400) {
            reject(new Error('Max file size exceeded (4GB)'))
            return
        }

        // Assign initial progress value
        uploadProgress[index] = 0

        // Create a unique identifier for this file
        const fileId = `${file.name}-${file.size}-${Date.now()}`

        // Create a new tus upload
        const upload = new tus.Upload(file, {
            endpoint: `${tusServerUrl}/upload`,
            retryDelays: [0, 3000, 5000, 10000, 20000],
            overridePatchMethod: false, // Use actual PATCH instead of POST with X-HTTP-Method-Override
            removeFingerprintOnSuccess: true,
            metadata: {
                filename: file.name,
                filetype: file.type,
                userId: tweetStore.loginUser?.mid || ''
            },
            onError: (error) => {
                console.error('Upload failed:', error)
                reject(error)
            },
            onProgress: (bytesUploaded, bytesTotal) => {
                uploadProgress[index] = Math.floor((bytesUploaded / bytesTotal) * 100)
                console.log('Uploading...', uploadProgress[index] + '%')
            },
            onSuccess: async () => {
                console.log('Upload successful 2', upload.url)
                try {
                    // Get the file ID from the server
                    const response = await axios.post(`${tusServerUrl}/files/register`, {
                        uploadUrl: upload.url
                    })

                    // Remove from localStorage
                    const storedUploads = JSON.parse(localStorage.getItem('resumableUploads') || '{}')
                    delete storedUploads[fileId]
                    localStorage.setItem('resumableUploads', JSON.stringify(storedUploads))

                    resolve(response.data.id)
                } catch (error) {
                    reject(error)
                }
            }
        })

        // Store the upload instance
        uploads.value[index] = upload

        // Store upload URL in localStorage for potential resume
        upload.findPreviousUploads().then((previousUploads) => {
            if (previousUploads.length) {
                upload.resumeFromPreviousUpload(previousUploads[0])
            }

            upload.start()

            // Save to localStorage when we have a URL
            upload.options.onSuccess = () => {
                console.log('Upload successful 1', upload.url)
                if (upload.url) {
                    const storedUploads = JSON.parse(localStorage.getItem('resumableUploads') || '{}')
                    storedUploads[fileId] = {
                        url: upload.url,
                        filename: file.name,
                        size: file.size,
                        createdAt: Date.now()
                    }
                    localStorage.setItem('resumableUploads', JSON.stringify(storedUploads))
                }

                // Continue with your existing success logic
                axios.post(`${tusServerUrl}/files/register`, {
                    uploadUrl: upload.url
                })
                    .then(response => {
                        // Remove from localStorage
                        const storedUploads = JSON.parse(localStorage.getItem('resumableUploads') || '{}')
                        delete storedUploads[fileId]
                        localStorage.setItem('resumableUploads', JSON.stringify(storedUploads))

                        resolve(response.data.id)
                    })
                    .catch(error => {
                        reject(error)
                    })
            }
        })
    })
}

async function onSubmit() {
    loading.value = true
    try {
        if (filesUpload.value.length < 1) {
            alertStore.error('Please select at least one file')
            loading.value = false
            return
        }

        const results = []

        for (let i = 0; i < filesUpload.value.length; i++) {
            const file = filesUpload.value[i]
            let mid

            if (isResumableUpload.value) {
                mid = await uploadFileWithTus(file, i)
            }

            results.push({
                name: file.name,
                mid: mid
            })
        }

        textValue.value = ""
        filesUpload.value = []
        alertStore.success(`Files uploaded successfully: ${results.map(r => r.name).join(', ')}`)
    } catch (err) {
        // something wrong uploading files, abort
        console.error('onSubmit err:', err)
        alertStore.error(err)
    } finally {
        loading.value = false
    }
}

// Pause upload
function pauseUpload(index: number) {
    if (uploads.value[index]) {
        uploads.value[index].abort()
        console.warn(`Upload paused. You can resume later.`)
    }
}
// Resume upload
function resumeUpload(index: number) {
    if (uploads.value[index]) {
        uploads.value[index].start()
    }
}

// select input file
async function onSelect(e: Event) {
    const files =
        (e as HTMLInputEvent).target.files ||
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
    if (i !== -1) {
        // If there's an active upload, abort it
        if (uploads.value[i]) {
            uploads.value[i].abort()
            uploads.value.splice(i, 1)
        }
        filesUpload.value.splice(i, 1)
        uploadProgress.splice(i, 1)
    }
}
</script>

<template>
    <div class="row justify-content-start align-items-start">
        <div class="col-sm-12 col-md-8 col-lg-6" style="background-color:aliceblue;">
            <div class="card-header d-flex align-items-center">
                <input v-model="isResumableUpload" type="checkbox" checked>&nbsp;Enable resumable uploads</input>
            </div>
            <div class="modal-content" @dragover.prevent="dragOver" @drop.prevent="onSelect">
                <div class="input-container">
                    <textarea ref="textArea" v-model="textValue" placeholder="Add a description for your files..."
                        class="input-textarea"></textarea>
                    <div ref="dropHere" hidden class="drop-here">
                        <p>DROP FILES HERE</p>
                    </div>
                </div>
                <form @submit.prevent="onSubmit" enctype="multipart/form-data" @paste.prevent="onSelect"
                    class="form-container">
                    <input ref="selectFiles" @change="onSelect" type="file" hidden multiple />
                    <div class="button-container">
                        <button class="btn" @click.prevent="selectFiles.click()">Choose Files</button>
                        <button class="btn" type="submit">Upload</button>
                    </div>
                    <Loading :visible="loading" />
                </form>
            </div>
            <div ref="divAttach" hidden class="preview-container">
                <div v-for="(file, index) in filesUpload" :key="index" class="file-item">
                    <Preview @file-canceled="removeFile(file)" v-bind:src="file"
                        v-bind:progress="uploadProgress[index]"></Preview>
                    <div class="file-controls"
                        v-if="isResumableUpload && uploadProgress[index] > 0 && uploadProgress[index] < 100">
                        <button class="btn-small" @click="pauseUpload(index)">Pause</button>
                        <button class="btn-small" @click="resumeUpload(index)">Resume</button>
                    </div>
                </div>
            </div>
            <!-- <div class="upload-info">
                <p>
                    <strong>Large File Upload Features:</strong>
                <ul>
                    <li>Resumable uploads - continue where you left off if your connection drops</li>
                    <li>Upload multiple files at once</li>
                    <li>Pause and resume individual uploads</li>
                    <li>Maximum file size: 3GB</li>
                </ul>
                </p>
            </div> -->
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
    display: flex;
    align-items: center;
    justify-content: center;
    background-color: #f8f9fa;
    border-style: dashed;
}

.drop-here p {
    font-size: 1.5rem;
    color: #6c757d;
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

.btn-small {
    border-radius: 3px;
    border: 1px solid rgb(26, 25, 25);
    padding: 2px 8px;
    margin-right: 5px;
    font-size: 0.8rem;
    background-color: #f8f9fa;
}

.file-item {
    margin-bottom: 10px;
}

.file-controls {
    display: flex;
    margin-top: 5px;
    justify-content: flex-end;
}

.upload-info {
    margin: 15px 10px;
    padding: 10px;
    background-color: #f8f9fa;
    border-radius: 5px;
    border: 1px solid #dee2e6;
}

.upload-info ul {
    margin-top: 5px;
    padding-left: 20px;
}

.upload-info li {
    margin-bottom: 5px;
}
</style>