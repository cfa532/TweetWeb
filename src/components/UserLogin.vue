<script setup lang="ts">
import { ref, computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { Form, Field } from 'vee-validate';
import * as Yup from 'yup';
import { useTweetStore } from '@/stores';
import { useRouter } from "vue-router";
import { useAlertStore } from '@/stores';

const { t } = useI18n();

const router = useRouter();
const alertStore = useAlertStore();
const emit = defineEmits<{
    dismiss: []
}>();

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
        errorMessage.value = t('auth.usernamePasswordRequired');
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
            errorMessage.value = t('auth.loginFailed');
        }
    } catch (error: any) {
        console.error("Login error:", error);
        errorMessage.value = error?.message || t('auth.loginFailed');
    } finally {
        isLoading.value = false;
    }
}

function dismissLogin() {
    emit('dismiss');
    if (router.currentRoute.value.name === 'login') {
        router.replace('/');
    }
}

</script>

<template>
<div class="login-modal-overlay">
    <section class="login-modal" role="dialog" aria-modal="true" :aria-label="$t('auth.login')">
        <div class="login-modal-header">
            <h4 class="login-modal-title">{{ $t('auth.login') }}</h4>
            <button
                type="button"
                class="login-dismiss-button"
                :aria-label="$t('common.close')"
                @click="dismissLogin"
            >
                <span aria-hidden="true">&times;</span>
            </button>
        </div>
        <div class="login-modal-body">
            <Form @submit="onSubmit" :validation-schema="schema" v-slot="{ errors, isSubmitting }">
                <div class="form-group" style="margin-top: 0px;">
                    <label>{{ $t('auth.username') }}</label>
                    <Field 
                        name="username" 
                        type="text" 
                        class="form-control" 
                        :class="{ 'is-invalid': errors.username }"
                        :disabled="isLoading || isSubmitting"
                        @input="(e: Event) => username = (e.target as HTMLInputElement).value"
                    />
                    <div class="invalid-feedback">{{ errors.username }}</div>
                </div>
                <div class="form-group">
                    <label>{{ $t('auth.password') }}</label>
                    <Field 
                        name="password" 
                        type="password" 
                        class="form-control" 
                        :class="{ 'is-invalid': errors.password }"
                        :disabled="isLoading || isSubmitting"
                        @input="(e: Event) => password = (e.target as HTMLInputElement).value"
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
                        {{ (isSubmitting || isLoading) ? $t('auth.loggingIn') : $t('auth.login') }}
                    </button>
                </div>

                <div class="login-register-action">
                    <RouterLink
                        :to="{ name: 'account', query: { view: 'register', redirect: props.redirect } }"
                    >
                        {{ $t('auth.register') }}
                    </RouterLink>
                </div>
            </Form>
        </div>
    </section>
</div>
</template>

<style scoped>
.login-modal-overlay {
    box-sizing: border-box;
    display: flex;
    justify-content: center;
    width: min(calc(100% - 16px), 420px);
    margin: 24px auto;
    padding: 0;
    background: rgba(241, 243, 245, 0.94);
    border-radius: 8px;
}

.login-modal {
    width: 100%;
    max-width: 420px;
    max-height: calc(100vh - 72px);
    overflow-y: auto;
    background: #fff;
    border-radius: 8px;
    box-shadow: 0 20px 48px rgba(0, 0, 0, 0.28);
}

.login-modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 16px 18px;
    border-bottom: 1px solid #dee2e6;
}

.login-modal-title {
    margin: 0;
    font-size: 1.1rem;
    font-weight: 600;
}

.login-dismiss-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 36px;
    flex: 0 0 36px;
    border: 0;
    border-radius: 50%;
    background: transparent;
    color: #495057;
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
}

.login-dismiss-button:hover,
.login-dismiss-button:focus-visible {
    background: #f1f3f5;
    color: #212529;
}

.login-modal-body {
    padding: 18px;
}

.form-group {
    margin-top: 10px;
}

.login-register-action {
    margin-top: 14px;
    text-align: center;
}

@media (max-width: 480px) {
    .login-modal-overlay {
        width: calc(100% - 16px);
        margin: 12px auto;
    }
}
</style>
