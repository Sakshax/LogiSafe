/**
 * app.js — LogiSafe Main Application Orchestrator
 *
 * Handles:
 *  - Role-Based Access Control (RBAC) routing
 *  - View lifecycle management
 *  - Auth state observation
 *  - Toast notification system
 */

import { onAuthChange, loginWithEmail, mockLogin, logout, getRole, ROLES } from './modules/auth.js';
import { initAdminView, destroyAdminView } from './ui/admin-view.js';
import { initManagerView, destroyManagerView } from './ui/manager-view.js';
import { initDriverView, destroyDriverView } from './ui/driver-view.js';

// ─── DOM Cache ──────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

// ─── Init ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    bindNavEvents();
    bindAuthFormEvents();
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
        // Slight delay for CSS transition
        requestAnimationFrame(() => {
            el.classList.add('active');
        });
    }
}

function showAuthView() {
    // Destroy previous views
    destroyAdminView();
    destroyManagerView();
    destroyDriverView();

    showView('auth-view');

    // Hide nav user info
    const userControls = $('user-controls');
    if (userControls) userControls.classList.add('hidden');
    $('nav-logo-subtitle')?.classList.add('hidden');
}

function showDashboard(role) {
    // Destroy all views first
    destroyAdminView();
    destroyManagerView();
    destroyDriverView();

    // Show correct view
    showView(`${role}-view`);

    // Update nav
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

    // Initialize module
    switch (role) {
        case ROLES.ADMIN:   initAdminView();   break;
        case ROLES.MANAGER: initManagerView(); break;
        case ROLES.DRIVER:  initDriverView();  break;
    }

    showToast(`Welcome! ${role.charAt(0).toUpperCase() + role.slice(1)} dashboard loaded.`, 'success');
}

// ─── Auth Form ──────────────────────────────────────────────────────────
function bindAuthFormEvents() {
    const loginBtn = $('login-btn');
    const emailInput = $('email-input');
    const passwordInput = $('password-input');

    if (loginBtn) {
        loginBtn.addEventListener('click', async () => {
            const email = emailInput?.value?.trim();
            const password = passwordInput?.value || 'demo123';

            if (!email) {
                showToast('Please enter an email address.', 'error');
                return;
            }

            loginBtn.disabled = true;
            loginBtn.innerHTML = '<span class="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>';

            await loginWithEmail(email, password);

            loginBtn.disabled = false;
            loginBtn.innerHTML = 'Sign In';
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

// ─── Nav Active Link ────────────────────────────────────────────────────
function bindNavEvents() {
    // Nothing extra for now — nav is simple
}

// ─── Toast Notification System ──────────────────────────────────────────
let toastTimeout = null;

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
