<script setup lang="ts">
import { useAlertStore } from '@/stores';
import { watch, ref } from 'vue';

const emit = defineEmits(['save', 'cancel']);
const props = defineProps<{
    isVisible: boolean;
}>();
const selectedFiles = ref<MimeiFileType[]>([]);
const fileInput = ref<HTMLInputElement | null>(null); // Ref for the file input element
const showFileInput = ref(false);

const selectFile = () => {
    showFileInput.value = true;
    // Programmatically trigger the file input
    if (fileInput.value) {
        fileInput.value.click();
    }
};
function getMedaiType(t: string) {
  if (t.startsWith('image/')) return 'Image'
  if (t.startsWith('video/')) return 'Video'
  if (t.startsWith('audio/')) return 'Audio'
  return 'Uknown'
}
const getVideoAspectRatio = (file: File): Promise<number> => {
    return new Promise((resolve, reject) => {
        const video = document.createElement('video');
        video.preload = 'metadata';

        video.onloadedmetadata = () => {
            window.URL.revokeObjectURL(video.src);
            const aspectRatio = video.videoWidth / video.videoHeight;
            resolve(aspectRatio);
        };

        video.onerror = (error) => {
            window.URL.revokeObjectURL(video.src);
            reject(error);
        };

        video.src = URL.createObjectURL(file);
    });
};

const handleFileSelect = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
        const file = target.files[0];

        let aspectRatio: number | null = null;
        if (file.type.startsWith('video')) {
            try {
                aspectRatio = await getVideoAspectRatio(file);
            } catch (error) {
                console.error("Error getting video aspect ratio:", error);
                // Handle the error appropriately, maybe set a default value or inform the user
                aspectRatio = 1; // Default to 1 if we can't get the aspect ratio
            }
        }

        const mimeiFile: MimeiFileType = {
            mid: '',
            type: getMedaiType(file.type),
            size: file.size,
            fileName: file.name,
            timestamp: Date.now(),
            aspectRatio: aspectRatio || undefined, // Add aspect ratio to the file object
        };

        selectedFiles.value.push(mimeiFile);
        showFileInput.value = false;
    }
};

const removeFile = (index: number) => {
    if (selectedFiles.value.length > 1) {
        selectedFiles.value.splice(index, 1);
    }
};
const emitSelectFiles = () => {
    // Check if all selected files have a non-empty 'mid'
    const allMidsFilled = selectedFiles.value.every(file => file.mid.trim() !== '');

    if (allMidsFilled) {
        console.log(selectedFiles.value);
        emit('save', selectedFiles.value);
    } else {
        // Optionally, provide user feedback that all 'mid' fields must be filled.
        useAlertStore().error('Please fill in all the Cid fields before saving.');
    }
};
const cancel = () => {
    emit('cancel');
};
watch(() => props.isVisible, (isVisible) => {
    if (isVisible) {
        selectedFiles.value = [];
    }
});
</script>

<template>
    <div v-if="isVisible" class="link-input-modal">
        <div class="modal-content">
            <input
                type="file"
                style="display: none"
                @change="handleFileSelect"
                ref="fileInput"
                accept="image/*,video/*"
            />
            <div v-for="(file, index) in selectedFiles" :key="index" class="input-group">
                <p>{{ file.fileName }}</p>
                <p v-if="file.aspectRatio">Aspect Ratio: {{ file.aspectRatio.toFixed(2) }}</p>
                <div class="cid-container">
                    <input type="text" v-model="file.mid" placeholder="Enter Cid" />
                    <button @click="removeFile(index)" class="delete-button">×</button>
                </div>
            </div>
            <div class="button-group">
                <button @click="selectFile" class="add-button">Add mimei</button>
                <button @click="emitSelectFiles" class="save-button">Save</button>
                <button @click="cancel" class="cancel-button">Cancel</button>
            </div>
        </div>
    </div>
</template>

<style scoped>
.link-input-modal {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    background-color: rgba(0, 0, 0, 0.5);
    display: flex;
    justify-content: center;
    align-items: center;
    z-index: 1000;
}

.modal-content {
    background-color: white;
    padding: 20px;
    border-radius: 8px;
    box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
    width: 600px;
}

.input-group {
    display: flex;
    flex-direction: column;
    margin-bottom: 10px;
}

.input-group input {
    flex: 1;
    padding: 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    margin-right: 5px;
}

.delete-button {
    background-color: #f44336;
    color: white;
    border: none;
    padding: 0px 12px;
    border-radius: 4px;
    cursor: pointer;
    font-size: 24px;
    /* Adjust size as needed */
    line-height: 1;
    /* Remove extra spacing */
}

.add-button {
    background-color: #4caf50;
    color: white;
    border: none;
    padding: 10px 15px;
    border-radius: 4px;
    cursor: pointer;
    margin-bottom: 10px;
}

.button-group {
    display: flex;
    justify-content: flex-end;
    margin-top: 15px;
    /* Added these lines */
    gap: 20px;
    /* Adds spacing between buttons */
}

.button-group button {
    /* Added these lines */
    flex: 1;
    /* Makes buttons take equal width */
    height: 36px;
    /* Sets a consistent height */
    padding: 0;
    /* Reset padding to avoid conflicts */
    display: flex;
    /* Centers content vertically */
    align-items: center;
    /* Centers content vertically */
    justify-content: center;
    /* Centers content horizontally */
}

.cid-container {
    display: flex;
    align-items: center; /* vertically centers the items */
  }
  
  .cid-container input {
    flex-grow: 1;  /* this makes the input fill the available space, if desired */
    margin-right: 5px; /* optional margin between the input and button */
  }
</style>