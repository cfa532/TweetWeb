<script setup lang="ts">
import { ref, reactive, onMounted, onBeforeUnmount } from 'vue'
import { Loading, Preview } from '@/views'
import { useTweetStore, useAlertStore } from '@/stores'
import { useRoute, useRouter } from 'vue-router';
import * as tus from 'tus-js-client';

const router = useRouter();
interface HTMLInputEvent extends Event {
    target: HTMLInputElement & EventTarget
}
let tusServerUrl = ""
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
const isResumableUpload = ref(true)
const uploads = ref<any[]>([]) // Store tus upload instances
const abortControllers = ref<AbortController[]>([])

interface StoredUpload {
    url: string;
    filename: string;
    size: number;
    createdAt: number;
    file: File | null; // Store the File object
}

onMounted(async () => {
    let ip = tweetStore.getIpWithoutPort(tweetStore.loginUser?.providerIp as string)
    tusServerUrl = `http://${ip}:${tweetStore.loginUser?.cloudDrivePort}`
    console.log("TUS server", tusServerUrl)

    // Check if there are any uploads in progress from localStorage
    const storedUploadsString = localStorage.getItem('resumableUploads');
    if (storedUploadsString) {
        try {
            const storedUploads = JSON.parse(storedUploadsString);
            for (const fileId in storedUploads) {
                if (storedUploads.hasOwnProperty(fileId)) {
                    const uploadData: StoredUpload = storedUploads[fileId];
                    // Attempt to re-add the file to filesUpload if it's not already there.
                    // This is crucial for resuming uploads after a page refresh.
                    if (!filesUpload.value.some(file => file.name === uploadData.filename && file.size === uploadData.size)) {
                        // We can't directly reconstruct the File object from localStorage.
                        // The user needs to re-select the file.  We store the metadata and URL.
                        // When the user re-selects the file, we can check if there's a matching
                        // entry in localStorage and resume the upload.
                        console.warn(`File ${uploadData.filename} needs to be re-selected to resume upload.`);
                    }
                }
            }
        } catch (e) {
            console.error('Failed to parse stored uploads', e);
        }
    }
})

// Helper function to handle individual file uploads with tus
async function uploadFileWithTus(file: File, index: number = 0): Promise<string> {
    const controller = new AbortController();
    abortControllers.value[index] = controller;

    return new Promise((resolve, reject) => {
        if (controller.signal.aborted) {
            reject(new Error('Upload aborted'));
            return;
        }

        if (file.size > sliceSize * 400) {
            reject(new Error('Max file size exceeded (4GB)'));
            return;
        }

        uploadProgress[index] = 0;
        const fileId = `${file.name}-${file.size}-${Date.now()}`;
        console.log(`Starting upload for ${file.name} (${file.size} bytes) to ${tusServerUrl}/upload`);

        const upload = new tus.Upload(file, {
            endpoint: `${tusServerUrl}/upload`,
            retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000],
            chunkSize: 1024 * 1024, // 1MB chunks for better reliability and performance
            overridePatchMethod: false,
            removeFingerprintOnSuccess: true,
            metadata: {
                filename: file.name,
                filetype: file.type,
                userId: tweetStore.loginUser?.mid || '',
                username: tweetStore.loginUser?.username || '',
            },
            onError: (error) => {
                console.error('Upload failed:', error);
                let errorMessage = 'Upload failed';
                if (error.message) {
                    console.log('Full error message:', error.message);
                    const responseTextMatch = error.message.match(/response text: ([^,]+)/);
                    if (responseTextMatch && responseTextMatch[1]) {
                        errorMessage = responseTextMatch[1].trim();
                    }
                }
                alertStore.error(errorMessage);
                controller.abort();
                reject(new Error(errorMessage));
            },
            onProgress: (bytesUploaded, bytesTotal) => {
                uploadProgress[index] = (bytesUploaded / bytesTotal) * 100;
                console.log(`Progress for ${file.name}: ${Math.round(uploadProgress[index])}% (${bytesUploaded}/${bytesTotal} bytes)`);
            },
            onSuccess: async () => {  // Modified onSuccess function
                console.log(`Upload completed successfully for ${file.name}`);
                uploadProgress[index] = 100;

                // **NEW: Call the /files/register endpoint**
                try {
                    const uploadUrl = upload.url; // Get the final upload URL from tus
                    if (!uploadUrl) {
                        throw new Error('Upload URL is missing after successful upload.');
                    }

                    const registerResponse = await fetch(`${tusServerUrl}/files/register`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({
                            uploadUrl: uploadUrl,
                            filename: file.name,
                            filetype: file.type,
                        }),
                    });

                    if (!registerResponse.ok) {
                        const errorText = await registerResponse.text();
                        throw new Error(`File registration failed: ${registerResponse.status} - ${errorText}`);
                    }

                    const registerData = await registerResponse.json();
                    console.log('File registration successful:', registerData);
                    resolve(registerData.id); // Resolve with the file ID from the server
                } catch (registerError) {
                    console.error('Error registering file:', registerError);
                    reject(registerError); // Reject the promise if registration fails
                }
            },
        });

        uploads.value[index] = upload;
        controller.signal.addEventListener('abort', () => {
            console.log('Upload aborted via AbortController');
            if (upload) {
                upload.abort();
            }
        });

        console.log(`Checking for previous uploads for ${file.name}`);
        upload.findPreviousUploads().then((previousUploads) => {
            if (previousUploads.length) {
                console.log(`Found previous upload for ${file.name}, attempting to resume`);
                upload.resumeFromPreviousUpload(previousUploads[0]);
                upload.start();
            } else {
                console.log(`No previous uploads found for ${file.name}, starting new upload`);
                upload.start();
            }
        }).catch(err => {
            console.error('Error finding or resuming previous uploads:', err);
            console.log(`Starting fresh upload for ${file.name} after error`);

            // Check if the error is a 404
            if (err.originalError && err.originalError.status === 404) {
                console.warn('Previous upload not found on server, starting a new upload.');
                upload.start(); // Start a new upload directly
            } else {
                console.error('Error finding or resuming previous uploads:', err);
                console.log(`Starting fresh upload for ${file.name} after error`);
                upload.start();
            }
        });
    });
}

onBeforeUnmount(() => {
    console.log('Component unmounting, aborting uploads');
    abortControllers.value.forEach(controller => controller.abort());
    uploads.value.forEach(upload => {
        if (upload) upload.abort();
    });
    // Don't clear localStorage here.  We want to preserve the upload state across sessions.
    // localStorage.removeItem('resumableUploads');
});

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
        uploadProgress.length = 0; // Clear the upload progress array
        uploads.value.length = 0; // Clear the uploads array
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
                // Check if there's a stored upload for this file
                const fileId = `${f.name}-${f.size}`;
                const storedUploadsString = localStorage.getItem('resumableUploads') || '{}';
                const storedUploads = JSON.parse(storedUploadsString);
                if (storedUploads[fileId]) {
                    console.log(`Found stored upload for ${f.name}.  Will attempt to resume.`);
                }

                // remove duplication
                if (!inpCaption.value || inpCaption.value.trim() === '') {
                    inpCaption.value = f.name
                }
                filesUpload.value.push(f)
                uploadProgress.push(0); // Initialize progress for the new file
                uploads.value.push(null); // Initialize upload instance
                abortControllers.value.push(new AbortController()); // Initialize abort controller
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
            abortControllers.value[i].abort();
            abortControllers.value.splice(i, 1);
        }
        filesUpload.value.splice(i, 1)
        uploadProgress.splice(i, 1)
    }
}
</script>

<template>

    <div class="row justify-content-start align-items-start mt-2">
        <div class="col-sm-12 col-md-8 col-lg-6" style="background-color:aliceblue;">
            <div class="card-header d-flex align-items-center">
                <input v-model="isResumableUpload" type="checkbox" checked>&nbsp;Enable resumable uploads</input>
                <span @click='router.push({name: "netdisk"})' class='breadcrumb-link'>Netdisk</span>
                <span @click='router.push({name: "main"})' class='breadcrumb-link'>Home</span>
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
        </div>
    </div>
</template>

<style scoped>
.breadcrumb-link {
    color: #007bff;
    text-decoration: none;
    cursor: pointer;
    margin-left: 30px;
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