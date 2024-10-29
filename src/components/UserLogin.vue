<script setup lang="ts">
import { Form, Field } from 'vee-validate';
import * as Yup from 'yup';
import { useTweetStore } from '@/stores/tweetStore';
import { useRouter } from "vue-router";
const router = useRouter()

const schema = Yup.object().shape({
    username: Yup.string().required('Username is required'),
    password: Yup.string().required('Password is required'),
    keyphrase: Yup.string().required('Key phrase is required'),
});

async function onSubmit(values: any) {
    const tweetStore = useTweetStore();
    const { username, password, keyphrase } = values;
    let user = await tweetStore.login(username, password, keyphrase);
    if (user) {
        sessionStorage.setItem("userId", JSON.stringify(user))
        router.push("upload")
    }
}
</script>

<template>
    <div class="card m-3">
        <h4 class="card-header">Login</h4>
        <div class="card-body">
            <Form @submit="onSubmit" :validation-schema="schema" v-slot="{ errors, isSubmitting }">
                <div class="form-group" style="margin-top: 0px;">
                    <label>Username</label>
                    <Field name="username" type="text" class="form-control" :class="{ 'is-invalid': errors.username }" />
                    <div class="invalid-feedback">{{ errors.username }}</div>
                </div>
                <div class="form-group">
                    <label>Password</label>
                    <Field name="password" type="password" class="form-control" :class="{ 'is-invalid': errors.password }" />
                    <div class="invalid-feedback">{{ errors.password }}</div>
                </div>
                <div class="form-group">
                    <label>Key phrase</label>
                    <Field name="keyphrase" type="text" class="form-control" :class="{ 'is-invalid': errors.keyphrase }" />
                    <div class="invalid-feedback">{{ errors.keyphrase }}</div>
                </div>
                <div class="form-group">
                    <button class="btn btn-primary" :disabled="isSubmitting">
                        <span v-show="isSubmitting" class="spinner-border spinner-border-sm mr-1"></span>
                        Login
                    </button>
                </div>
            </Form>
        </div>
    </div>
</template>
<style>
.form-group {
    margin-top: 10px;
}
</style>
