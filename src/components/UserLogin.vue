<script setup lang="ts">
import { ref, computed } from 'vue';
import { Form, Field } from 'vee-validate';
import * as Yup from 'yup';
import { useTweetStore } from '@/stores';
import { useRouter } from "vue-router";
import { useAlertStore } from '@/stores';

const router = useRouter();
const alertStore = useAlertStore();

const props = defineProps({
  redirect: {
    type: String,
    default: '/'
  }
});

const username = ref('');
const password = ref('');
const errorMessage = ref<string | null>(null);
const isLoading = ref(false);

const schema = Yup.object().shape({
    username: Yup.string().required('Username is required'),
    password: Yup.string().required('Password is required'),
});

const canSubmit = computed(() => {
    return !isLoading.value && username.value.trim() !== '' && password.value.trim() !== '';
});

async function onSubmit(values: any) {
    isLoading.value = true;
    errorMessage.value = null;
    alertStore.clear();
    
    const tweetStore = useTweetStore();
    const { username: usernameValue, password: passwordValue } = values;
    
    // Validate fields are not empty (like iOS version)
    if (!usernameValue || !passwordValue) {
        errorMessage.value = 'Username & password are required.';
        isLoading.value = false;
        return;
    }
    
    try {
        let user = await tweetStore.login(usernameValue, passwordValue);
        if (user) {
            console.log("Login successful", user);
            router.push(props.redirect);
        } else {
            // Error message should be handled by tweetStore via alertStore
            // But we can also show it inline for better UX
            errorMessage.value = 'Login failed. Please check your credentials.';
        }
    } catch (error: any) {
        console.error("Login error:", error);
        errorMessage.value = error?.message || 'Login failed. Please try again.';
    } finally {
        isLoading.value = false;
    }
}

</script>

<template>
<div class="col-sm-12 col-md-8 col-lg-6" >
    <div class="card m-3">
        <h4 class="card-header">Login</h4>
        <div class="card-body">
            <h5 class="mb-4">Welcome to dTweet</h5>
            
            <Form @submit="onSubmit" :validation-schema="schema" v-slot="{ errors, isSubmitting }">
                <div class="form-group" style="margin-top: 0px;">
                    <label>Username</label>
                    <Field 
                        name="username" 
                        type="text" 
                        class="form-control" 
                        :class="{ 'is-invalid': errors.username }"
                        :disabled="isLoading || isSubmitting"
                        @input="(e) => username = (e.target as HTMLInputElement).value"
                    />
                    <div class="invalid-feedback">{{ errors.username }}</div>
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <Field 
                        name="password" 
                        type="password" 
                        class="form-control" 
                        :class="{ 'is-invalid': errors.password }"
                        :disabled="isLoading || isSubmitting"
                        @input="(e) => password = (e.target as HTMLInputElement).value"
                    />
                    <div class="invalid-feedback">{{ errors.password }}</div>
                </div>
                
                <div v-if="errorMessage" class="alert alert-danger" role="alert">
                    {{ errorMessage }}
                </div>
                
                <div class="form-group">
                    <button 
                        class="btn btn-primary w-100" 
                        :disabled="!canSubmit || isSubmitting || isLoading"
                    >
                        <span v-show="isSubmitting || isLoading" class="spinner-border spinner-border-sm mr-1"></span>
                        {{ (isSubmitting || isLoading) ? 'Logging in...' : 'Login' }}
                    </button>
                </div>
            </Form>
        </div>
    </div>
</div>
</template>

<style>
.form-group {
    margin-top: 10px;
}
</style>
