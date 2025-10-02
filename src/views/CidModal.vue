<script setup lang="ts">
import { useAlertStore } from '@/stores';
import { watch, ref } from 'vue';
import { getVideoAspectRatio, getImageAspectRatio } from '@/utils/uploadUtils';

// Helper function to get human-readable aspect ratio names
function getAspectRatioDisplayName(ratio: number): string {
  const tolerance = 0.01;
  if (Math.abs(ratio - (4/3)) < tolerance) return '4:3';
  if (Math.abs(ratio - (16/9)) < tolerance) return '16:9';
  if (Math.abs(ratio - (21/9)) < tolerance) return '21:9';
  if (Math.abs(ratio - (16/10)) < tolerance) return '16:10';
  if (Math.abs(ratio - (3/2)) < tolerance) return '3:2';
  if (Math.abs(ratio - (9/16)) < tolerance) return '9:16 (portrait)';
  if (Math.abs(ratio - 1) < tolerance) return '1:1 (square)';
  return `${ratio.toFixed(3)}:1`;
}

const emit = defineEmits(['save', 'cancel']);
const props = defineProps<{
    isVisible: boolean;
}>();
const selectedFiles = ref<MimeiFileType[]>([]);
const fileInput = ref<HTMLInputElement | null>(null); // Ref for the file input element
const showFileInput = ref(false);
const originalFileStates = ref<Map<number, MimeiFileType>>(new Map());

const selectFile = () => {
    showFileInput.value = true;
    // Programmatically trigger the file input
    if (fileInput.value) {
        fileInput.value.click();
    }
};
function getMediaType(t: string, filename?: string) {
  const lowerType = t.toLowerCase();
  if (lowerType.startsWith('image/')) return 'Image'
  if (lowerType.startsWith('video/')) return 'hls_video' // Default to hls_video for video MIME types
  if (lowerType.startsWith('audio/')) return 'Audio'
  
  // Fallback to file extension if MIME type is not recognized
  if (filename) {
    const ext = filename.toLowerCase().split('.').pop();
    if (['mkv', 'avi', 'mp4', 'mov', 'wmv', 'flv', 'webm', 'm4v', '3gp', 'ogv'].includes(ext || '')) {
      return 'hls_video'; // Default to hls_video for video files
    }
    if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff'].includes(ext || '')) {
      return 'Image';
    }
    if (['mp3', 'wav', 'ogg', 'aac', 'flac', 'm4a', 'wma'].includes(ext || '')) {
      return 'Audio';
    }
  }
  
  return 'Unknown' // Return 'Unknown' for unrecognized types to match uploadUtils.ts
}
// Note: getVideoAspectRatio and getImageAspectRatio are imported from uploadUtils.ts

const handleFileSelect = async (event: Event) => {
    const target = event.target as HTMLInputElement;
    if (target.files && target.files.length > 0) {
        const file = target.files[0];

        let aspectRatio: number | null = null;
        const mediaType = getMediaType(file.type, file.name);
        
        if (mediaType === 'hls_video') {
            try {
                aspectRatio = await getVideoAspectRatio(file);
                console.log(`🎬 [FILE SELECTION] Video: ${file.name}`);
                console.log(`📐 [FILE SELECTION] Aspect ratio: ${aspectRatio.toFixed(3)} (${getAspectRatioDisplayName(aspectRatio)})`);
            } catch (error) {
                console.error("Error getting video aspect ratio:", error);
                // The getVideoAspectRatio from uploadUtils.ts already has fallback logic and should not fail
                // If it still fails, use a more reasonable default based on file extension
                const fileName = file.name.toLowerCase();
                if (fileName.endsWith('.avi')) {
                    // AVI files can have various aspect ratios, but 3:2 (1.5) and 4:3 (1.333) are common
                    aspectRatio = 3/2; // 1.5 - common for many AVI files
                } else if (fileName.endsWith('.mov')) {
                    aspectRatio = 4/3; // 1.333... - common for older video formats
                } else {
                    aspectRatio = 16/9; // 1.777... - common for modern video formats
                }
                console.log(`⚠️ [FILE SELECTION] Using fallback aspect ratio ${aspectRatio.toFixed(3)} (${getAspectRatioDisplayName(aspectRatio)}) for ${file.name}`);
            }
        } else if (mediaType === 'Image') {
            try {
                aspectRatio = await getImageAspectRatio(file);
                console.log(`🖼️ [FILE SELECTION] Image: ${file.name}`);
                console.log(`📐 [FILE SELECTION] Aspect ratio: ${aspectRatio.toFixed(3)} (${getAspectRatioDisplayName(aspectRatio)})`);
            } catch (error) {
                console.error("Error getting image aspect ratio:", error);
                // Default to 1:1 for images if detection fails
                aspectRatio = 1; // Default to 1 if we can't get the aspect ratio
                console.log(`⚠️ [FILE SELECTION] Using default aspect ratio 1:1 for ${file.name}`);
            }
        }

        const mimeiFile: MimeiFileType = {
            mid: '',
            type: getMediaType(file.type, file.name),
            size: file.size,
            fileName: file.name,
            timestamp: Date.now(),
            aspectRatio: aspectRatio || undefined, // Add aspect ratio to the file object
        };

        selectedFiles.value.push(mimeiFile);
        // Store original state for cancel functionality
        const fileIndex = selectedFiles.value.length - 1;
        originalFileStates.value.set(fileIndex, { ...mimeiFile });
        showFileInput.value = false;
        
        // Clear the file input to allow reselecting the same file
        target.value = '';
    }
};

const removeFile = (index: number) => {
    selectedFiles.value.splice(index, 1);
    originalFileStates.value.delete(index);
    // Reindex the remaining original states
    const newStates = new Map();
    selectedFiles.value.forEach((file, newIndex) => {
        // Files that were at positions >= index+1 are now at positions >= index
        // So we need to look for original states at oldIndex = newIndex + (newIndex >= index ? 1 : 0)
        const oldIndex = newIndex >= index ? newIndex + 1 : newIndex;
        const oldState = originalFileStates.value.get(oldIndex);
        if (oldState) {
            newStates.set(newIndex, oldState);
        }
    });
    originalFileStates.value = newStates;
};

const updateAspectRatio = (file: MimeiFileType, event: Event) => {
    const target = event.target as HTMLInputElement;
    const value = parseFloat(target.value);
    if (!isNaN(value)) {
        file.aspectRatio = value;
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
    selectedFiles.value = [];
    originalFileStates.value.clear();
    showFileInput.value = false;
    emit('cancel');
};
watch(() => props.isVisible, (isVisible) => {
    if (isVisible) {
        selectedFiles.value = [];
        originalFileStates.value.clear();
    }
});
</script>

<template>
    <div v-if="isVisible" class="link-input-modal" @click="cancel">
        <div class="modal-content" @click.stop>
            <input
                type="file"
                style="display: none"
                @change="handleFileSelect"
                ref="fileInput"
                accept="image/*,video/*,.mkv,.avi"
            />
            <div v-for="(file, index) in selectedFiles" :key="index" class="file-card">
                <div class="file-header">
                    <h4>{{ file.fileName }}</h4>
                    <button @click="removeFile(index)" class="delete-button">×</button>
                </div>
                
                <div class="file-fields">
                    <div class="field-row">
                        <div class="field-group full-width">
                            <label>File Name</label>
                            <input type="text" v-model="file.fileName" />
                        </div>
                    </div>
                    
                    <div class="field-row">
                        <div class="field-group" v-if="file.aspectRatio">
                            <label>Aspect Ratio</label>
                            <input type="number" :value="file.aspectRatio ? file.aspectRatio.toFixed(2) : ''" @input="updateAspectRatio(file, $event)" step="0.01" />
                        </div>
                        <div class="field-group">
                            <label>Type</label>
                            <select v-model="file.type">
                                <option value="hls_video">HLS Video</option>
                                <option value="video">Video</option>
                                <option value="Image">Image</option>
                                <option value="Audio">Audio</option>
                                <option value="Unknown">Unknown</option>
                            </select>
                        </div>
                    </div>
                    
                    <div class="field-row">
                        <div class="field-group full-width">
                            <label>CID</label>
                            <input type="text" v-model="file.mid" placeholder="Enter CID" />
                        </div>
                    </div>
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

.file-card {
    background: #fff;
    border: 1px solid #e1e5e9;
    border-radius: 12px;
    margin-bottom: 16px;
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
    overflow: hidden;
}

.file-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    background: #f8f9fa;
    border-bottom: 1px solid #e1e5e9;
}

.file-header h4 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: #2c3e50;
    word-break: break-all;
}

.file-fields {
    padding: 20px;
}

.field-row {
    display: flex;
    gap: 16px;
    margin-bottom: 16px;
}

.field-row:last-child {
    margin-bottom: 0;
}

.field-group {
    flex: 1;
    display: flex;
    flex-direction: column;
}

.field-group.full-width {
    flex: 1;
}

.field-group label {
    font-size: 12px;
    font-weight: 600;
    color: #6c757d;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 6px;
}

.field-group input,
.field-group select {
    padding: 10px 12px;
    border: 1px solid #d1d5db;
    border-radius: 6px;
    font-size: 14px;
    transition: border-color 0.2s, box-shadow 0.2s;
    background: #fff;
}

.field-group input:focus,
.field-group select:focus {
    outline: none;
    border-color: #3b82f6;
    box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
}

.field-group input[type="number"] {
    max-width: none;
}

.input-group input {
    flex: 1;
    padding: 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    margin-right: 5px;
}

.delete-button {
    background-color: #ef4444;
    color: white;
    border: none;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    font-size: 18px;
    font-weight: bold;
    line-height: 1;
    transition: background-color 0.2s;
    min-width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
}

.delete-button:hover {
    background-color: #dc2626;
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