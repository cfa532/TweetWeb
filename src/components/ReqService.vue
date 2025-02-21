<script setup lang="ts">
import { computed, onMounted, ref, onUnmounted } from 'vue';
import { useTweetStore } from '@/stores';
// import axios from 'axios'; // Import Axios for making HTTP requests

const formData = ref({
    username: '',
    accountId: '',
    message: 'Please help me to delete my account.'
});

const isSubmitting = ref(false);
const submissionSuccess = ref(false);
const submissionError = ref();

const handleSubmit = async () => {
    isSubmitting.value = true;
    submissionSuccess.value = false;
    submissionError.value = null;

    try {
        // Replace with your actual API endpoint
        const apiUrl = '/api/send-email'; //  Important:  This is a placeholder.  You need a backend!

        // const response = await axios.post(apiUrl, formData.value);

        // if (response.status === 200) {
        //     submissionSuccess.value = true;
        //     formData.value = { username: '', accountId: '', message: '' }; // Clear the form
        // } else {
        //     submissionError.value = 'Server returned an error.';
        // }
    } catch (error: any) {
        console.error('Error submitting form:', error);
        submissionError.value = error.message || 'An unexpected error occurred.';
    } finally {
        isSubmitting.value = false;
    }
};
</script>

<template>
    <div class="container">
        <h1>Submit a Request</h1>
        <form @submit.prevent="handleSubmit">
            <div class="form-group">
                <label for="username">Username:</label>
                <input type="text" id="username" v-model="formData.username" required class="form-control">
            </div>
            <div class="form-group">
                <label for="accountId">Host ID:</label>
                <input type="text" id="accountId" v-model="formData.accountId" required class="form-control">
            </div>
            <div class="form-group">
                <label for="message">Message:</label>
                <textarea id="message" v-model="formData.message" rows="4" required class="form-control"></textarea>
            </div>
            <button type="submit" class="btn btn-primary" :disabled="isSubmitting">
                {{ isSubmitting ? 'Submitting...' : 'Submit Request' }}
            </button>
            <div v-if="submissionSuccess" class="alert alert-success mt-3">
                Request submitted successfully!
            </div>
            <div v-if="submissionError" class="alert alert-danger mt-3">
                Error submitting request: {{ submissionError }}
            </div>
        </form>
    </div>
</template>

<style scoped>
.container {
    max-width: 600px;
    margin: 20px auto;
    padding: 20px;
    border: 1px solid #ccc;
    border-radius: 5px;
}

.form-group {
    margin-bottom: 15px;
}

label {
    display: block;
    margin-bottom: 5px;
    font-weight: bold;
}

input[type="text"],
textarea {
    width: 100%;
    padding: 8px;
    border: 1px solid #ccc;
    border-radius: 4px;
    box-sizing: border-box;
    /* Important: Include padding and border in the element's total width and height */
}

.btn-primary {
    background-color: #007bff;
    color: white;
    padding: 10px 15px;
    border: none;
    border-radius: 4px;
    cursor: pointer;
}

.btn-primary:hover {
    background-color: #0056b3;
}

.btn-primary:disabled {
    background-color: #ccc;
    cursor: not-allowed;
}

.alert {
    padding: 10px;
    border-radius: 4px;
}

.alert-success {
    background-color: #d4edda;
    color: #155724;
    border: 1px solid #c3e6cb;
}

.alert-danger {
    background-color: #f8d7da;
    color: #721c24;
    border: 1px solid #f5c6cb;
}
</style>