/**
 * auth.js — Authentication & Role-Based Access Control Module
 *
 * Handles Firebase Auth login/signup, role determination,
 * and demo/mock login for presentation purposes.
 */

import {
    auth,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut as fbSignOut,
    onAuthStateChanged
} from '../config/firebase-config.js';

// ─── Role Constants ─────────────────────────────────────────────────────
export const ROLES = Object.freeze({
    ADMIN: 'admin',
    MANAGER: 'manager',
    DRIVER: 'driver'
});

// ─── State ──────────────────────────────────────────────────────────────
let currentUser = null;
let currentRole = null;
let authChangeCallback = null;

/**
 * Register a callback that fires whenever user/role changes.
 * @param {Function} cb - (user, role) => void
 */
export function onAuthChange(cb) {
    authChangeCallback = cb;
}

/**
 * Sign in with email + password.
 * Role is inferred from the email prefix for demo purposes.
 * In production, roles would come from Firestore custom claims.
 */
export async function loginWithEmail(email, password) {
    try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        currentUser = cred.user;
        currentRole = inferRole(email);
        if (authChangeCallback) authChangeCallback(currentUser, currentRole);
        return { user: currentUser, role: currentRole };
    } catch (err) {
        // If Firebase Auth config isn't real, fall back to mock
        console.warn('Firebase Auth failed, using mock login:', err.code);
        return mockLogin(email);
    }
}

/**
 * Mock login for demo mode — no Firebase credentials needed.
 * @param {string} emailOrRole
 */
export function mockLogin(emailOrRole) {
    const role = inferRole(emailOrRole);
    currentUser = { uid: `demo-${role}-${Date.now()}`, email: `${role}@logisafe.demo`, displayName: role.charAt(0).toUpperCase() + role.slice(1) + ' User' };
    currentRole = role;
    if (authChangeCallback) authChangeCallback(currentUser, currentRole);
    return { user: currentUser, role: currentRole };
}

/**
 * Sign out the current user.
 */
export async function logout() {
    try { await fbSignOut(auth); } catch (e) { /* ignore in demo */ }
    currentUser = null;
    currentRole = null;
    if (authChangeCallback) authChangeCallback(null, null);
}

/**
 * Infer a role from an email string or direct role name.
 */
function inferRole(input) {
    const lower = (input || '').toLowerCase();
    if (lower.includes('admin')) return ROLES.ADMIN;
    if (lower.includes('manager') || lower.includes('site')) return ROLES.MANAGER;
    return ROLES.DRIVER;
}

// Getters
export function getUser() { return currentUser; }
export function getRole() { return currentRole; }
