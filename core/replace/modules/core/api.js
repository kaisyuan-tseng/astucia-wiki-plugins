import { showToast } from './utils.js';
import { state } from './state.js';
import { t } from '../i18n/index.js';

export const api = {
    call: async (action, params = {}, method = 'GET', signal = null) => {
        // Automatically include the active space in every request
        if (state.currentSpace && !Object.prototype.hasOwnProperty.call(params, 'space')) {
            params = { space: state.currentSpace, ...params };
        }

        let url = `api.php?action=${action}`;
        let options = { method };
        if (signal) options.signal = signal;

        if (method === 'GET') {
            if (Object.keys(params).length) {
                url += '&' + new URLSearchParams(params).toString();
            }
        } else {
            const formData = new FormData();
            for (const key in params) {
                formData.append(key, params[key]);
            }
            options.body = formData;
        }

        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                if (response.status === 401) {
                    window.location.href = 'login.php';
                    return { success: false };
                }
                let message;
                try { const e = await response.json(); message = e.message; } catch {}
                throw new Error(message || t('api.http-error', { status: response.status }));
            }
            const data = await response.json();
            if (data.session_expired) {
                window.location.href = 'login.php';
                return data;
            }
            // === local plugins: i18n of backend error messages ===
            // Backend permission/ACL messages carry a machine-readable `code`
            // (e.g. perm.denied). Map it through the i18n system here so every
            // caller's toast automatically shows the user's language instead of
            // the raw English server string.
            if (!data.success && data.code) {
                const localized = t(data.code);
                if (localized && localized !== data.code) data.message = localized;
            }
            // === end local plugins ===
            state.lastApiCallTime = Date.now();
            return data;
        } catch (error) {
            if (error.name === 'AbortError') return { success: false, aborted: true };
            console.error('API Error:', error);
            showToast(t('api.error-prefix', { error: error.message }), 'error');
            return { success: false, message: error.message };
        }
    },
};
