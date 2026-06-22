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
            // PoolTimeoutError (and any object with isTimeout:true) is a
            // network-level signal — not a user-action failure. Suppress it
            // here; diagnostics remain in the console via console.warn.
            if (message?.isTimeout) return
            this.alert = { message, type: 'alert-danger' };
        },
        warning(message: string) {
            this.alert = { message, type: 'alert-warning' };
        },
        clear() {
            this.alert = null;
        }
    }
});
