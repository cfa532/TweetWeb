<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useI18n } from 'vue-i18n';
import { useTweetStore, useAlertStore } from '@/stores';
import { useRouter } from 'vue-router';
import { formatTimeDifference } from '@/lib';

const { t } = useI18n();

const router = useRouter();
const tweetStore = useTweetStore();
const alertStore = useAlertStore();
const defaultAvatar = import.meta.env.VITE_APP_LOGO;
const MIMEI_ID_LENGTH = 27;

// View state: 'login' | 'register' | 'profile' | 'edit'
const activeView = ref('login');
const isLoading = ref(false);
const errorMessage = ref<string | null>(null);
const showDeleteConfirm = ref(false);
const showLogoutConfirm = ref(false);

// --- Login fields ---
const loginUsername = ref('');
const loginPassword = ref('');

// --- Registration fields (matching iOS Registration.swift) ---
const regUsername = ref('');
const regPassword = ref('');
const regConfirmPassword = ref('');
const regAlias = ref('');
const regProfile = ref('');
const regHostId = ref('');
// --- Edit profile fields (matching iOS ProfileEditView.swift) ---
const editName = ref('');
const editProfile = ref('');
const editPassword = ref('');
const editConfirmPassword = ref('');
const editHostId = ref('');
const editCloudDrivePort = ref('');
const editDomainToShare = ref('');
const backendDomain = ref('');

const user = computed(() => tweetStore.loginUser);
const isLoggedIn = computed(() => !!user.value);

onMounted(() => {
    if (isLoggedIn.value) {
        activeView.value = 'profile';
    }
});

function populateEditFields() {
    if (user.value) {
        editName.value = user.value.name || '';
        editProfile.value = user.value.profile || '';
        editPassword.value = '';
        editConfirmPassword.value = '';
        editHostId.value = user.value.hostIds?.[0] || '';
        editCloudDrivePort.value = user.value.cloudDrivePort ? String(user.value.cloudDrivePort) : '';
        editDomainToShare.value = '';
    }
}

function clearError() {
    errorMessage.value = null;
}

async function switchView(view: string) {
    clearError();
    activeView.value = view;
    if (view === 'edit') {
        populateEditFields();
        // Fetch backend domain for placeholder if user has no custom domain
        if (!editDomainToShare.value) {
            backendDomain.value = await tweetStore.fetchBackendDomain();
        }
    }
}

// ==================== LOGIN ====================
async function handleLogin() {
    const u = loginUsername.value.trim();
    const p = loginPassword.value.trim();
    if (!u || !p) {
        errorMessage.value = t('auth.usernamePasswordRequired');
        return;
    }
    isLoading.value = true;
    clearError();
    try {
        const result = await tweetStore.login(u, p);
        if (result) {
            activeView.value = 'profile';
            loginPassword.value = '';
        } else {
            errorMessage.value = t('auth.loginFailed');
        }
    } catch (err: any) {
        errorMessage.value = err?.message || 'Login failed.';
    } finally {
        isLoading.value = false;
    }
}

// ==================== REGISTRATION ====================
async function handleRegister() {
    clearError();
    const u = regUsername.value.trim();
    const p = regPassword.value.trim();
    const cp = regConfirmPassword.value.trim();

    if (!u || !p) {
        errorMessage.value = t('auth.usernamePasswordRequired');
        return;
    }
    if (p !== cp) {
        errorMessage.value = t('auth.passwordsMismatch');
        return;
    }
    if (regHostId.value.trim() && regHostId.value.trim().length !== MIMEI_ID_LENGTH) {
        errorMessage.value = t('auth.hostIdLength', { n: MIMEI_ID_LENGTH });
        return;
    }
    isLoading.value = true;
    try {
        await tweetStore.register(
            u, p,
            regAlias.value.trim() || undefined,
            regProfile.value.trim() || undefined,
            regHostId.value.trim() || undefined,
        );
        alertStore.success(t('auth.registrationSuccessful'));
        loginUsername.value = u;
        regPassword.value = '';
        regConfirmPassword.value = '';
        activeView.value = 'login';
    } catch (err: any) {
        errorMessage.value = err?.message || t('auth.registrationFailed');
    } finally {
        isLoading.value = false;
    }
}

// ==================== UPDATE PROFILE ====================
async function handleUpdateProfile() {
    clearError();

    if (editPassword.value && editPassword.value !== editConfirmPassword.value) {
        errorMessage.value = t('auth.passwordsMismatch');
        return;
    }
    if (editHostId.value.trim() && editHostId.value.trim().length !== MIMEI_ID_LENGTH) {
        errorMessage.value = t('auth.hostIdLength', { n: MIMEI_ID_LENGTH });
        return;
    }
    const port = editCloudDrivePort.value.trim();
    if (port) {
        const portNum = parseInt(port, 10);
        if (isNaN(portNum) || portNum < 8000 || portNum > 65535) {
            errorMessage.value = t('auth.portRange');
            return;
        }
    }

    isLoading.value = true;
    try {
        await tweetStore.updateProfile({
            name: editName.value.trim(),
            profile: editProfile.value.trim(),
            password: editPassword.value || undefined,
            hostId: editHostId.value.trim() || undefined,
            cloudDrivePort: port ? parseInt(port, 10) : undefined,
            domainToShare: editDomainToShare.value.trim() || undefined,
        });
        alertStore.success(t('auth.profileUpdated'));
        editPassword.value = '';
        editConfirmPassword.value = '';
        activeView.value = 'profile';
    } catch (err: any) {
        errorMessage.value = err?.message || t('auth.updateFailed');
    } finally {
        isLoading.value = false;
    }
}

// ==================== LOGOUT ====================
function handleLogout() {
    showLogoutConfirm.value = false;
    tweetStore.logout();
    activeView.value = 'login';
    loginUsername.value = '';
    loginPassword.value = '';
    clearError();
    router.push('/');
}

// ==================== DELETE ACCOUNT ====================
async function handleDeleteAccount() {
    showDeleteConfirm.value = false;
    isLoading.value = true;
    clearError();
    try {
        await tweetStore.deleteAccount();
        alertStore.success(t('auth.accountDeleted'));
        activeView.value = 'login';
        loginUsername.value = '';
        loginPassword.value = '';
        router.push('/');
    } catch (err: any) {
        errorMessage.value = err?.message || t('auth.deleteFailed');
    } finally {
        isLoading.value = false;
    }
}

function goBack() {
    router.back();
}
</script>

<template>
    <div class="account-page">
        <!-- Header -->
        <div class="account-header">
            <button class="btn btn-link btn-back" @click="goBack">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
                    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="15 18 9 12 15 6"></polyline>
                </svg>
            </button>
            <h5 class="mb-0">{{ $t('auth.account') }}</h5>
            <div style="width: 36px;"></div>
        </div>

        <!-- ==================== GUEST: LOGIN / REGISTER ==================== -->
        <div v-if="!isLoggedIn" class="account-body">
            <ul class="nav nav-tabs">
                <li class="nav-item">
                    <a class="nav-link" :class="{ active: activeView === 'login' }" href="#"
                        @click.prevent="switchView('login')">{{ $t('auth.login') }}</a>
                </li>
                <li class="nav-item">
                    <a class="nav-link" :class="{ active: activeView === 'register' }" href="#"
                        @click.prevent="switchView('register')">{{ $t('auth.register') }}</a>
                </li>
            </ul>

            <!-- LOGIN FORM -->
            <form v-if="activeView === 'login'" @submit.prevent="handleLogin" class="mt-3">
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.username') }}</label>
                    <input v-model="loginUsername" type="text" class="form-control" :disabled="isLoading"
                        autocomplete="username" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.password') }}</label>
                    <input v-model="loginPassword" type="password" class="form-control" :disabled="isLoading"
                        autocomplete="current-password" />
                </div>
                <div v-if="errorMessage" class="alert alert-danger py-2">{{ errorMessage }}</div>
                <button type="submit" class="btn btn-primary w-100" :disabled="isLoading">
                    <span v-if="isLoading" class="spinner-border spinner-border-sm me-1"></span>
                    {{ isLoading ? $t('auth.loggingIn') : $t('auth.login') }}
                </button>
            </form>

            <!-- REGISTRATION FORM (matches iOS Registration.swift) -->
            <form v-if="activeView === 'register'" @submit.prevent="handleRegister" class="mt-3">
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.username') }} <span class="text-danger">*</span></label>
                    <input v-model="regUsername" type="text" class="form-control" :disabled="isLoading"
                        autocomplete="username" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.password') }} <span class="text-danger">*</span></label>
                    <input v-model="regPassword" type="password" class="form-control" :disabled="isLoading"
                        autocomplete="new-password" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.confirmPassword') }} <span class="text-danger">*</span></label>
                    <input v-model="regConfirmPassword" type="password" class="form-control" :disabled="isLoading"
                        autocomplete="new-password" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.displayName') }}</label>
                    <input v-model="regAlias" type="text" class="form-control" :disabled="isLoading"
                        :placeholder="$t('auth.optional')" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.bio') }}</label>
                    <textarea v-model="regProfile" class="form-control" rows="3" :disabled="isLoading"
                        :placeholder="$t('auth.optional')"></textarea>
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.hostId') }}</label>
                    <input v-model="regHostId" type="text" class="form-control" :disabled="isLoading"
                        :maxlength="MIMEI_ID_LENGTH" :placeholder="$t('auth.hostIdPlaceholder')" />
                    <div class="form-text">{{ $t('auth.hostIdHint') }}</div>
                </div>
                <div v-if="errorMessage" class="alert alert-danger py-2">{{ errorMessage }}</div>
                <button type="submit" class="btn btn-primary w-100" :disabled="isLoading">
                    <span v-if="isLoading" class="spinner-border spinner-border-sm me-1"></span>
                    {{ isLoading ? $t('auth.creatingAccount') : $t('auth.createAccount') }}
                </button>
            </form>
        </div>

        <!-- ==================== LOGGED IN: PROFILE / EDIT ==================== -->
        <div v-else class="account-body">

            <!-- PROFILE VIEW (matches iOS ProfileView.swift) -->
            <div v-if="activeView === 'profile'">
                <div class="text-center mb-3">
                    <img :src="user?.avatar || defaultAvatar" class="rounded-circle profile-avatar"
                        alt="Avatar" @error="(e: Event) => (e.target as HTMLImageElement).src = defaultAvatar" />
                    <h5 class="mt-2 mb-0">{{ user?.name || user?.username }}</h5>
                    <span class="text-muted">@{{ user?.username }}</span>
                </div>

                <div v-if="user?.profile" class="bio-section mb-3">
                    <p class="mb-0">{{ user.profile }}</p>
                </div>

                <!-- Stats -->
                <div class="stats-row mb-3">
                    <div class="stat-item" @click="router.push(`/followers/${user?.mid}`)">
                        <div class="fw-bold">{{ user?.followersCount ?? 0 }}</div>
                        <small class="text-muted">{{ $t('profile.followers') }}</small>
                    </div>
                    <div class="stat-item" @click="router.push(`/followings/${user?.mid}`)">
                        <div class="fw-bold">{{ user?.followingCount ?? 0 }}</div>
                        <small class="text-muted">{{ $t('profile.following') }}</small>
                    </div>
                    <div class="stat-item" @click="router.push(`/author/${user?.mid}`)">
                        <div class="fw-bold">{{ user?.tweetCount ?? 0 }}</div>
                        <small class="text-muted">{{ $t('profile.tweets') }}</small>
                    </div>
                </div>

                <!-- Info rows -->
                <div class="info-section mb-3">
                    <div v-if="user?.hostIds?.[0]" class="info-row">
                        <span class="info-label">{{ $t('auth.hostId') }}</span>
                        <span class="info-value text-muted">{{ user.hostIds[0] }}</span>
                    </div>
                    <div v-if="user?.cloudDrivePort" class="info-row">
                        <span class="info-label">{{ $t('auth.cloudDrivePort') }}</span>
                        <span class="info-value text-muted">{{ user.cloudDrivePort }}</span>
                    </div>
                    <div class="info-row">
                        <span class="info-label">{{ $t('auth.joined') }}</span>
                        <span class="info-value text-muted">{{ formatTimeDifference(user?.timestamp as number) }}</span>
                    </div>
                </div>

                <div v-if="errorMessage" class="alert alert-danger py-2">{{ errorMessage }}</div>

                <!-- Actions -->
                <div class="d-grid gap-2">
                    <button class="btn btn-outline-primary" @click="switchView('edit')">{{ $t('auth.editProfile') }}</button>
                    <button class="btn btn-outline-secondary" @click="showLogoutConfirm = true">{{ $t('auth.logout') }}</button>
                    <button class="btn btn-outline-danger btn-sm mt-2" @click="showDeleteConfirm = true">{{ $t('auth.deleteAccount') }}</button>
                </div>
            </div>

            <!-- EDIT PROFILE (matches iOS ProfileEditView.swift) -->
            <form v-if="activeView === 'edit'" @submit.prevent="handleUpdateProfile">
                <div class="text-center mb-3">
                    <img :src="user?.avatar || defaultAvatar" class="rounded-circle profile-avatar"
                        alt="Avatar" @error="(e: Event) => (e.target as HTMLImageElement).src = defaultAvatar" />
                </div>

                <div class="mb-3">
                    <label class="form-label text-muted">{{ $t('auth.username') }}</label>
                    <input type="text" class="form-control" :value="user?.username" disabled />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.newPassword') }}</label>
                    <input v-model="editPassword" type="password" class="form-control" :disabled="isLoading"
                        :placeholder="$t('auth.passwordKeepCurrent')" autocomplete="new-password" />
                </div>
                <div v-if="editPassword" class="mb-3">
                    <label class="form-label">{{ $t('auth.confirmNewPassword') }}</label>
                    <input v-model="editConfirmPassword" type="password" class="form-control" :disabled="isLoading"
                        autocomplete="new-password" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.displayName') }}</label>
                    <input v-model="editName" type="text" class="form-control" :disabled="isLoading"
                        :placeholder="user?.name || ''" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.bio') }}</label>
                    <textarea v-model="editProfile" class="form-control" rows="3" :disabled="isLoading"
                        :placeholder="user?.profile || ''"></textarea>
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.hostId') }}</label>
                    <input v-model="editHostId" type="text" class="form-control" :disabled="isLoading"
                        :maxlength="MIMEI_ID_LENGTH" :placeholder="user?.hostIds?.[0] || $t('auth.hostIdPlaceholder')" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.cloudDrivePort') }}</label>
                    <input v-model="editCloudDrivePort" type="text" inputmode="numeric" class="form-control"
                        :disabled="isLoading" :placeholder="$t('auth.portPlaceholder')" />
                </div>
                <div class="mb-3">
                    <label class="form-label">{{ $t('auth.shareDomain') }}</label>
                    <input v-model="editDomainToShare" type="url" class="form-control" :disabled="isLoading"
                        :placeholder="backendDomain || $t('auth.shareDomainPlaceholder')" />
                </div>

                <div v-if="errorMessage" class="alert alert-danger py-2">{{ errorMessage }}</div>

                <div class="d-flex gap-2">
                    <button type="button" class="btn btn-outline-secondary flex-fill"
                        @click="switchView('profile')" :disabled="isLoading">{{ $t('common.cancel') }}</button>
                    <button type="submit" class="btn btn-primary flex-fill" :disabled="isLoading">
                        <span v-if="isLoading" class="spinner-border spinner-border-sm me-1"></span>
                        {{ isLoading ? $t('auth.saving') : $t('common.save') }}
                    </button>
                </div>
            </form>
        </div>

        <!-- ==================== CONFIRMATION DIALOGS ==================== -->

        <!-- Logout Confirmation -->
        <div v-if="showLogoutConfirm" class="confirm-overlay" @click.self="showLogoutConfirm = false">
            <div class="confirm-dialog">
                <p class="mb-3">{{ $t('auth.logoutConfirm') }}</p>
                <div class="d-flex gap-2">
                    <button class="btn btn-outline-secondary flex-fill" @click="showLogoutConfirm = false">{{ $t('common.cancel') }}</button>
                    <button class="btn btn-primary flex-fill" @click="handleLogout">{{ $t('auth.logout') }}</button>
                </div>
            </div>
        </div>

        <!-- Delete Account Confirmation -->
        <div v-if="showDeleteConfirm" class="confirm-overlay" @click.self="showDeleteConfirm = false">
            <div class="confirm-dialog">
                <h6 class="text-danger mb-2">{{ $t('auth.deleteAccount') }}</h6>
                <p class="mb-3">{{ $t('auth.deleteConfirm') }}</p>
                <div class="d-flex gap-2">
                    <button class="btn btn-outline-secondary flex-fill" @click="showDeleteConfirm = false">{{ $t('common.cancel') }}</button>
                    <button class="btn btn-danger flex-fill" @click="handleDeleteAccount" :disabled="isLoading">
                        <span v-if="isLoading" class="spinner-border spinner-border-sm me-1"></span>
                        {{ $t('common.delete') }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
.account-page {
    max-width: 500px;
    margin: 0 auto;
    min-height: 100vh;
    background: #fff;
}

.account-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    border-bottom: 1px solid #e9ecef;
    position: sticky;
    top: 0;
    background: #fff;
    z-index: 10;
}

.btn-back {
    padding: 4px;
    color: #333;
    text-decoration: none;
}

.account-body {
    padding: 16px;
}

.nav-tabs .nav-link {
    cursor: pointer;
}

.profile-avatar {
    width: 80px;
    height: 80px;
    object-fit: cover;
}

.bio-section {
    padding: 8px 12px;
    background: #f8f9fa;
    border-radius: 8px;
}

.stats-row {
    display: flex;
    justify-content: space-around;
    text-align: center;
    padding: 12px 0;
    border-top: 1px solid #e9ecef;
    border-bottom: 1px solid #e9ecef;
}

.stat-item {
    cursor: pointer;
    padding: 4px 12px;
    border-radius: 6px;
    transition: background 0.15s;
}

.stat-item:hover {
    background: #f0f0f0;
}

.info-section {
    padding: 0;
}

.info-row {
    display: flex;
    justify-content: space-between;
    padding: 8px 0;
    border-bottom: 1px solid #f0f0f0;
    font-size: 0.9rem;
}

.info-label {
    color: #495057;
}

.info-value {
    text-align: right;
    word-break: break-all;
    max-width: 60%;
}

.confirm-overlay {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}

.confirm-dialog {
    background: #fff;
    border-radius: 12px;
    padding: 24px;
    max-width: 340px;
    width: 100%;
    box-shadow: 0 8px 30px rgba(0, 0, 0, 0.2);
}
</style>
