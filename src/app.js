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
import { initDriverProfileView, destroyDriverProfileView } from './ui/driver-profile-view.js';
import { initTrackingLinkView, destroyTrackingLinkView } from './ui/tracking-link-view.js';
import { stopTracking } from './modules/tracking.js';

// ─── DOM Cache ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Init ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    bindTabSwitcher();
    bindAuthFormEvents();
    bindRegisterFormEvents();
    bindMockLoginEvents();
    bindLogout();

    // Check for temporary tracking link
    const urlParams = new URLSearchParams(window.location.search);
    const trackToken = urlParams.get('track_token');
    
    if (trackToken) {
        // Show tracking view directly — it has its own login gate
        const guestControls = $('guest-controls');
        if (guestControls) guestControls.classList.add('hidden');
        
        showView('tracking-link-view');
        initTrackingLinkView(trackToken);
        return;
    }

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

    // Clean up tracking on window close
    window.addEventListener('beforeunload', () => {
        stopTracking();
    });
});

// ─── View Router ────────────────────────────────────────────────────────
const VIEW_IDS = ['auth-view', 'admin-view', 'manager-view', 'driver-profile-view', 'tracking-link-view'];

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
    destroyDriverProfileView();
    destroyTrackingLinkView();

    showView('auth-view');

    const userControls = $('user-controls');
    if (userControls) userControls.classList.add('hidden');
    const guestControls = $('guest-controls');
    if (guestControls) guestControls.classList.remove('hidden');
    
    $('nav-logo-subtitle')?.classList.add('hidden');

    // Reset to login tab
    switchToTab('login');
}

function showDashboard(role) {
    destroyAdminView();
    destroyManagerView();
    destroyDriverProfileView();
    destroyTrackingLinkView();

    if (role === ROLES.DRIVER) {
        showView('driver-profile-view');
    } else {
        showView(`${role}-view`);
    }

    const userControls = $('user-controls');
    if (userControls) userControls.classList.remove('hidden');
    const guestControls = $('guest-controls');
    if (guestControls) guestControls.classList.add('hidden');

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
        case ROLES.DRIVER:  initDriverProfileView();  break;
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
            tabLogin.style.background = '#7A8C3E';
            tabLogin.style.color = '#fff';
            tabLogin.style.boxShadow = '0 4px 12px rgba(122,140,62,0.3)';
        }
        if (tabRegister) {
            tabRegister.style.background = 'transparent';
            tabRegister.style.color = '#64748B';
            tabRegister.style.boxShadow = 'none';
        }
    } else {
        if (loginForm) loginForm.classList.add('hidden');
        if (registerForm) registerForm.classList.remove('hidden');
        if (tabRegister) {
            tabRegister.style.background = '#7A8C3E';
            tabRegister.style.color = '#fff';
            tabRegister.style.boxShadow = '0 4px 12px rgba(122,140,62,0.3)';
        }
        if (tabLogin) {
            tabLogin.style.background = 'transparent';
            tabLogin.style.color = '#64748B';
            tabLogin.style.boxShadow = 'none';
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

            // Validate truck license and mobile for drivers
            const truckLicense = $('reg-truck-license')?.value?.trim();
            const mobile = $('reg-mobile')?.value?.trim();
            if (role === 'driver') {
                if (!truckLicense) {
                    showStatusMessage('register-status', 'Please enter your truck license number.', 'error');
                    return;
                }
                if (!mobile) {
                    showStatusMessage('register-status', 'Please enter your mobile number.', 'error');
                    return;
                }
            }

            registerBtn.disabled = true;
            registerBtn.innerHTML = '<span class="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>';
            hideStatusMessage('register-status');

            const result = await registerUser({ name, email, password, role, truckLicense, mobile });

            registerBtn.disabled = false;
            registerBtn.innerHTML = 'Create Account';

            if (result.success) {
                showStatusMessage('register-status', result.message, 'success');
                // Clear form
                if ($('reg-name')) $('reg-name').value = '';
                if ($('reg-email')) $('reg-email').value = '';
                if ($('reg-password')) $('reg-password').value = '';
                if ($('reg-truck-license')) $('reg-truck-license').value = '';
                if ($('reg-mobile')) $('reg-mobile').value = '';

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
    if (type === 'success') {
        el.style.cssText = 'padding:12px;border-radius:12px;font-size:13px;font-weight:500;background:rgba(122,140,62,0.1);color:#7A8C3E;border:1px solid rgba(122,140,62,0.2);';
    } else {
        el.style.cssText = 'padding:12px;border-radius:12px;font-size:13px;font-weight:500;background:rgba(224,85,53,0.1);color:#E05535;border:1px solid rgba(224,85,53,0.2);';
    }
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
        container.style.cssText = 'position:fixed;top:80px;right:16px;z-index:100;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
        document.body.appendChild(container);
    }

    const colors = {
        success: { bg: '#7A8C3E', icon: '✓' },
        error:   { bg: '#E05535', icon: '✕' },
        info:    { bg: '#1C1C1C', icon: 'ℹ' },
        warning: { bg: '#F4A623', icon: '⚠' },
    };
    const tc = colors[type] || colors.info;

    const toast = document.createElement('div');
    toast.style.cssText = `background:${tc.bg};color:#fff;padding:10px 20px;border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,0.25);backdrop-filter:blur(8px);display:flex;align-items:center;gap:10px;font-size:13px;font-weight:500;pointer-events:auto;transform:translateX(120%);transition:transform 0.3s ease;max-width:340px;`;
    toast.innerHTML = `<span style="flex-shrink:0;width:24px;height:24px;border-radius:50%;background:rgba(255,255,255,0.2);display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;">${tc.icon}</span><span>${message}</span>`;

    container.appendChild(toast);
    requestAnimationFrame(() => { toast.style.transform = 'translateX(0)'; });

    setTimeout(() => {
        toast.style.transform = 'translateX(120%)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}
