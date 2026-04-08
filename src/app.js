/**
 * app.js — LogiSafe Main Application Orchestrator v3
 *
 * Handles:
 *  - Role-Based Access Control (RBAC) routing
 *  - View lifecycle management
 *  - Login / Registration tab switching
 *  - Auth state observation with error handling
 *  - Toast notification system
 */

import { onAuthChange, loginWithEmail, registerUser, mockLogin, logout, getRole, ROLES } from './modules/auth.js';
import { initAdminView, destroyAdminView } from './ui/admin-view.js';
import { initManagerView, destroyManagerView } from './ui/manager-view.js';
import { initDriverView, destroyDriverView } from './ui/driver-view.js';

// ─── DOM Cache ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Init ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    bindTabSwitcher();
    bindAuthFormEvents();
    bindRegisterFormEvents();
    bindMockLoginEvents();
    bindLogout();

    // Listen for auth state changes
    onAuthChange((user, role) => {
        if (user && role) {
            showDashboard(role);
        } else {
            showAuthView();
        }
    });

    // Start with auth view
    showAuthView();
});

// ─── View Router ────────────────────────────────────────────────────────
const VIEW_IDS = ['auth-view', 'admin-view', 'manager-view', 'driver-view'];

function hideAllViews() {
    VIEW_IDS.forEach(id => {
        const el = $(id);
        if (el) {
            el.classList.remove('active');
            el.classList.add('hidden');
        }
    });
}

function showView(viewId) {
    hideAllViews();
    const el = $(viewId);
    if (el) {
        el.classList.remove('hidden');
        requestAnimationFrame(() => {
            el.classList.add('active');
        });
    }
}

function showAuthView() {
    destroyAdminView();
    destroyManagerView();
    destroyDriverView();

    showView('auth-view');

    const userControls = $('user-controls');
    if (userControls) userControls.classList.add('hidden');
    $('nav-logo-subtitle')?.classList.add('hidden');

    // Reset to login tab
    switchToTab('login');
}

function showDashboard(role) {
    destroyAdminView();
    destroyManagerView();
    destroyDriverView();

    showView(`${role}-view`);

    const userControls = $('user-controls');
    if (userControls) userControls.classList.remove('hidden');

    const badge = $('user-role-badge');
    if (badge) {
        badge.textContent = role;
        const roleColors = {
            admin: 'bg-violet-500/20 text-violet-300',
            manager: 'bg-blue-500/20 text-blue-300',
            driver: 'bg-emerald-500/20 text-emerald-300',
        };
        badge.className = `px-3 py-1 rounded-lg text-xs font-bold uppercase tracking-wider ${roleColors[role] || ''}`;
    }

    const subtitle = $('nav-logo-subtitle');
    if (subtitle) {
        const subtitles = { admin: 'City Overview', manager: 'Site Command', driver: 'Active Trip' };
        subtitle.textContent = subtitles[role] || '';
        subtitle.classList.remove('hidden');
    }

    switch (role) {
        case ROLES.ADMIN:   initAdminView();   break;
        case ROLES.MANAGER: initManagerView(); break;
        case ROLES.DRIVER:  initDriverView();  break;
    }

    showToast(`Welcome! ${role.charAt(0).toUpperCase() + role.slice(1)} dashboard loaded.`, 'success');
}

// ─── Tab Switcher (Login ↔ Register) ────────────────────────────────────
function bindTabSwitcher() {
    const tabLogin = $('tab-login');
    const tabRegister = $('tab-register');
    const switchToReg = $('switch-to-register');
    const switchToLog = $('switch-to-login');

    if (tabLogin) tabLogin.addEventListener('click', () => switchToTab('login'));
    if (tabRegister) tabRegister.addEventListener('click', () => switchToTab('register'));
    if (switchToReg) switchToReg.addEventListener('click', () => switchToTab('register'));
    if (switchToLog) switchToLog.addEventListener('click', () => switchToTab('login'));
}

function switchToTab(tab) {
    const loginForm = $('login-form');
    const registerForm = $('register-form');
    const tabLogin = $('tab-login');
    const tabRegister = $('tab-register');

    // Clear status messages
    hideStatusMessage('login-status');
    hideStatusMessage('register-status');

    if (tab === 'login') {
        if (loginForm) loginForm.classList.remove('hidden');
        if (registerForm) registerForm.classList.add('hidden');
        if (tabLogin) {
            tabLogin.classList.add('bg-blue-600', 'text-white', 'shadow-lg');
            tabLogin.classList.remove('text-slate-400');
        }
        if (tabRegister) {
            tabRegister.classList.remove('bg-blue-600', 'text-white', 'shadow-lg');
            tabRegister.classList.add('text-slate-400');
        }
    } else {
        if (loginForm) loginForm.classList.add('hidden');
        if (registerForm) registerForm.classList.remove('hidden');
        if (tabRegister) {
            tabRegister.classList.add('bg-blue-600', 'text-white', 'shadow-lg');
            tabRegister.classList.remove('text-slate-400');
        }
        if (tabLogin) {
            tabLogin.classList.remove('bg-blue-600', 'text-white', 'shadow-lg');
            tabLogin.classList.add('text-slate-400');
        }
    }
}

// ─── Login Form ─────────────────────────────────────────────────────────
function bindAuthFormEvents() {
    const loginBtn = $('login-btn');
    const emailInput = $('email-input');
    const passwordInput = $('password-input');

    if (loginBtn) {
        loginBtn.addEventListener('click', async () => {
            const email = emailInput?.value?.trim();
            const password = passwordInput?.value?.trim();

            if (!email) {
                showStatusMessage('login-status', 'Please enter your email address.', 'error');
                return;
            }
            if (!password) {
                showStatusMessage('login-status', 'Please enter your password.', 'error');
                return;
            }

            loginBtn.disabled = true;
            loginBtn.innerHTML = '<span class="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>';
            hideStatusMessage('login-status');

            const result = await loginWithEmail(email, password);

            loginBtn.disabled = false;
            loginBtn.innerHTML = 'Sign In';

            if (!result.success) {
                showStatusMessage('login-status', result.error, 'error');
            }
            // If successful, onAuthChange callback handles the routing
        });
    }

    // Enter key support
    [emailInput, passwordInput].forEach(input => {
        if (input) {
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') loginBtn?.click();
            });
        }
    });
}

// ─── Registration Form ──────────────────────────────────────────────────
function bindRegisterFormEvents() {
    const registerBtn = $('register-btn');
    const rolePickBtns = document.querySelectorAll('.role-pick-btn');
    const regRole = $('reg-role');
    const truckLicenseField = $('truck-license-field');

    // Role selector buttons
    rolePickBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const role = btn.dataset.role;
            if (regRole) regRole.value = role;

            // Update button styles
            rolePickBtns.forEach(b => {
                b.classList.remove('border-blue-500', 'border-emerald-500', 'text-white', 'bg-blue-500/10', 'bg-emerald-500/10');
                b.classList.add('border-white/10', 'text-slate-400');
            });

            if (role === 'manager') {
                btn.classList.add('border-blue-500', 'text-white', 'bg-blue-500/10');
                btn.classList.remove('border-white/10', 'text-slate-400');
                if (truckLicenseField) truckLicenseField.classList.add('hidden');
            } else {
                btn.classList.add('border-emerald-500', 'text-white', 'bg-emerald-500/10');
                btn.classList.remove('border-white/10', 'text-slate-400');
                if (truckLicenseField) truckLicenseField.classList.remove('hidden');
            }
        });
    });

    // Register submit
    if (registerBtn) {
        registerBtn.addEventListener('click', async () => {
            const name = $('reg-name')?.value?.trim();
            const email = $('reg-email')?.value?.trim();
            const password = $('reg-password')?.value?.trim();
            const role = regRole?.value;

            if (!name) {
                showStatusMessage('register-status', 'Please enter your full name.', 'error');
                return;
            }
            if (!email) {
                showStatusMessage('register-status', 'Please enter your email.', 'error');
                return;
            }
            if (!password || password.length < 6) {
                showStatusMessage('register-status', 'Password must be at least 6 characters.', 'error');
                return;
            }
            if (!role) {
                showStatusMessage('register-status', 'Please select your role (Manager or Driver).', 'error');
                return;
            }

            // Validate truck license for drivers
            const truckLicense = $('reg-truck-license')?.value?.trim();
            if (role === 'driver' && !truckLicense) {
                showStatusMessage('register-status', 'Please enter your truck license number.', 'error');
                return;
            }

            registerBtn.disabled = true;
            registerBtn.innerHTML = '<span class="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>';
            hideStatusMessage('register-status');

            const result = await registerUser({ name, email, password, role, truckLicense });

            registerBtn.disabled = false;
            registerBtn.innerHTML = 'Create Account';

            if (result.success) {
                showStatusMessage('register-status', result.message, 'success');
                // Clear form
                if ($('reg-name')) $('reg-name').value = '';
                if ($('reg-email')) $('reg-email').value = '';
                if ($('reg-password')) $('reg-password').value = '';
                if ($('reg-truck-license')) $('reg-truck-license').value = '';

                // Auto-switch to login after 3 seconds
                setTimeout(() => switchToTab('login'), 3000);
            } else {
                showStatusMessage('register-status', result.error, 'error');
            }
        });
    }

    // Enter key on password → submit
    const regPassword = $('reg-password');
    if (regPassword) {
        regPassword.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') registerBtn?.click();
        });
    }
}

// ─── Status Messages ────────────────────────────────────────────────────
function showStatusMessage(elId, message, type) {
    const el = $(elId);
    if (!el) return;
    el.classList.remove('hidden');
    el.className = `p-3 rounded-xl text-sm font-medium ${
        type === 'success'
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : 'bg-red-500/10 text-red-400 border border-red-500/20'
    }`;
    el.textContent = message;
}

function hideStatusMessage(elId) {
    const el = $(elId);
    if (el) {
        el.classList.add('hidden');
        el.textContent = '';
    }
}

// ─── Mock Login Buttons ─────────────────────────────────────────────────
function bindMockLoginEvents() {
    document.querySelectorAll('.mock-login-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const role = e.currentTarget.dataset.role;
            mockLogin(role);
        });
    });
}

// ─── Logout ─────────────────────────────────────────────────────────────
function bindLogout() {
    const logoutBtn = $('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async () => {
            await logout();
            showToast('Signed out successfully.', 'info');
        });
    }
}

// ─── Toast Notification System ──────────────────────────────────────────
function showToast(message, type = 'info') {
    let container = $('toast-container');
    if (!container) {
        container = document.createElement('div');
        container.id = 'toast-container';
        container.className = 'fixed top-20 right-4 z-[100] space-y-2 pointer-events-none';
        document.body.appendChild(container);
    }

    const typeConfig = {
        success: { bg: 'bg-emerald-600/90', icon: '✓' },
        error:   { bg: 'bg-red-600/90', icon: '✕' },
        info:    { bg: 'bg-blue-600/90', icon: 'ℹ' },
        warning: { bg: 'bg-amber-600/90', icon: '⚠' },
    };
    const tc = typeConfig[type] || typeConfig.info;

    const toast = document.createElement('div');
    toast.className = `${tc.bg} text-white px-5 py-3 rounded-xl shadow-2xl backdrop-blur-sm flex items-center gap-3 text-sm font-medium pointer-events-auto transform translate-x-full transition-transform duration-300 max-w-sm`;
    toast.innerHTML = `<span class="flex-shrink-0 w-6 h-6 rounded-full bg-white/20 flex items-center justify-center text-xs font-bold">${tc.icon}</span><span>${message}</span>`;

    container.appendChild(toast);
    requestAnimationFrame(() => toast.classList.remove('translate-x-full'));

    setTimeout(() => {
        toast.classList.add('translate-x-full');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}
