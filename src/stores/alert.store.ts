import { defineStore } from 'pinia';

// type Nullable<T> = T | undefined | null;
// interface Alert {
//     alert? : {"message":string, "type":string} | null
// }

export const useAlertStore = defineStore({
    id: 'alert',
    state: () => ({
        alert: <{"message":string, "type":string} | null>null
    }),
    actions: {
        success(message: string) {
            this.alert = { message, type: 'alert-success' };
        },
        error(message: any) {
            this.alert = { message, type: 'alert-danger' };
        },
        clear() {
            this.alert = null;
        }
    }
});
