/**
 * auth.js — Authentication & Role-Based Access Control Module v3
 *
 * Registration & Login System:
 *  - ADMIN: Single hardcoded account. Login only, no registration.
 *  - MANAGER: Self-register → immediately active. Can login right away.
 *  - DRIVER: Self-register → status='pending'. Admin must approve before login works.
 *
 * User records stored in Firestore `users` collection:
 *   { uid, email, name, role, status: 'active'|'pending'|'rejected', registeredAt }
 */

import {
    auth, db,
    signInWithEmailAndPassword,
    createUserWithEmailAndPassword,
    signOut as fbSignOut,
    onAuthStateChanged,
    collection, doc, setDoc, getDocs, query, where, orderBy, deleteDoc, Timestamp
} from '../config/firebase-config.js';

// ─── Role Constants ─────────────────────────────────────────────────────
export const ROLES = Object.freeze({
    ADMIN: 'admin',
    MANAGER: 'manager',
    DRIVER: 'driver'
});

// ─── Hardcoded Admin Credential ─────────────────────────────────────────
// This is the ONLY admin account. No registration for admins.
const ADMIN_EMAIL = 'admin@logisafe.mbmc.gov.in';

// ─── State ──────────────────────────────────────────────────────────────
let currentUser = null;
let currentRole = null;
let authChangeCallback = null;

/**
 * Register a callback that fires whenever user/role changes.
 * Also fires with (null, null, errorMsg) on login failures.
 * @param {Function} cb - (user, role, error?) => void
 */
export function onAuthChange(cb) {
    authChangeCallback = cb;
}

// ─── LOGIN ──────────────────────────────────────────────────────────────

/**
 * Sign in with email + password.
 * Checks Firestore for user role and approval status.
 * @returns {{ success: boolean, user?, role?, error? }}
 */
export async function loginWithEmail(email, password) {
    try {
        const cred = await signInWithEmailAndPassword(auth, email, password);
        const uid = cred.user.uid;

        // Look up user profile in Firestore
        const userProfile = await getUserProfile(uid);

        if (!userProfile) {
            // Edge case: auth account exists but no Firestore profile
            // Check if it's the admin email
            if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
                currentUser = { uid, email, displayName: 'Admin' };
                currentRole = ROLES.ADMIN;
                if (authChangeCallback) authChangeCallback(currentUser, currentRole);
                return { success: true, user: currentUser, role: currentRole };
            }
            await fbSignOut(auth);
            return { success: false, error: 'Account not found. Please register first.' };
        }

        // Check driver approval status
        if (userProfile.role === ROLES.DRIVER && userProfile.status === 'pending') {
            await fbSignOut(auth);
            return { success: false, error: 'Your driver account is pending admin approval. Please wait for confirmation.' };
        }

        if (userProfile.role === ROLES.DRIVER && userProfile.status === 'rejected') {
            await fbSignOut(auth);
            return { success: false, error: 'Your driver registration was rejected. Contact the admin for details.' };
        }

        currentUser = {
            uid,
            email: cred.user.email,
            displayName: userProfile.name || cred.user.email
        };
        currentRole = userProfile.role;
        if (authChangeCallback) authChangeCallback(currentUser, currentRole);
        return { success: true, user: currentUser, role: currentRole };

    } catch (err) {
        console.warn('Firebase Auth login error:', err.code);

        // Specific error messages
        const errorMap = {
            'auth/user-not-found': 'No account found with this email. Please register.',
            'auth/wrong-password': 'Incorrect password. Please try again.',
            'auth/invalid-email': 'Invalid email format.',
            'auth/invalid-credential': 'Invalid credentials. Check email and password.',
            'auth/too-many-requests': 'Too many attempts. Please wait and try again.',
        };

        return { success: false, error: errorMap[err.code] || `Login failed: ${err.message}` };
    }
}

// ─── REGISTRATION ───────────────────────────────────────────────────────

/**
 * Register a new Manager or Driver account.
 * - Manager: immediately active.
 * - Driver: status='pending', needs admin approval. Must include truckLicense.
 *
 * @param {{ name: string, email: string, password: string, role: 'manager'|'driver', truckLicense?: string }} data
 * @returns {{ success: boolean, message?: string, error?: string }}
 */
export async function registerUser({ name, email, password, role, truckLicense }) {
    // Block admin registration
    if (role === ROLES.ADMIN) {
        return { success: false, error: 'Admin accounts cannot be registered.' };
    }

    // Block registration with admin email
    if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
        return { success: false, error: 'This email is reserved for admin use.' };
    }

    try {
        // Create Firebase Auth account
        const cred = await createUserWithEmailAndPassword(auth, email, password);
        const uid = cred.user.uid;

        // Determine status based on role
        const status = role === ROLES.MANAGER ? 'active' : 'pending';

        // Create Firestore user profile
        const userProfile = {
            uid,
            email,
            name,
            role,
            status,
            registeredAt: Timestamp.now()
        };

        // Add truck license for drivers
        if (role === ROLES.DRIVER && truckLicense) {
            userProfile.truckLicense = truckLicense.toUpperCase().trim();
        }

        await setDoc(doc(db, 'users', uid), userProfile);

        // Sign out immediately after registration (force them to login)
        await fbSignOut(auth);

        if (role === ROLES.MANAGER) {
            return {
                success: true,
                message: 'Registration successful! You can now sign in with your credentials.'
            };
        } else {
            return {
                success: true,
                message: 'Registration submitted! Your account is pending admin approval. You will be able to login once approved.'
            };
        }

    } catch (err) {
        console.warn('Registration error:', err.code);

        const errorMap = {
            'auth/email-already-in-use': 'An account with this email already exists. Try logging in.',
            'auth/weak-password': 'Password must be at least 6 characters.',
            'auth/invalid-email': 'Invalid email format.',
        };

        return { success: false, error: errorMap[err.code] || `Registration failed: ${err.message}` };
    }
}

// ─── MOCK LOGIN (Demo) ─────────────────────────────────────────────────

/**
 * Mock login for demo mode — no Firebase credentials needed.
 * @param {string} emailOrRole
 */
export function mockLogin(emailOrRole) {
    const role = inferRole(emailOrRole);
    currentUser = {
        uid: `demo-${role}-${Date.now()}`,
        email: `${role}@logisafe.demo`,
        displayName: role.charAt(0).toUpperCase() + role.slice(1) + ' User'
    };
    currentRole = role;
    if (authChangeCallback) authChangeCallback(currentUser, currentRole);
    return { success: true, user: currentUser, role: currentRole };
}

// ─── ADMIN: Pending Driver Management ───────────────────────────────────

/**
 * Get all pending driver registration requests.
 * @returns {Promise<Array<{ uid, name, email, registeredAt }>>}
 */
export async function getPendingDrivers() {
    try {
        const q = query(
            collection(db, 'users'),
            where('role', '==', ROLES.DRIVER),
            where('status', '==', 'pending')
        );
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('Failed to fetch pending drivers:', err.message);
        return [];
    }
}

/**
 * Get all approved (active) drivers.
 * Used by the Manager booking form to populate the driver dropdown.
 * @returns {Promise<Array<{ uid, name, email }>>}
 */
export async function getApprovedDrivers() {
    try {
        const q = query(
            collection(db, 'users'),
            where('role', '==', ROLES.DRIVER),
            where('status', '==', 'active')
        );
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('Failed to fetch approved drivers:', err.message);
        return [];
    }
}

/**
 * Approve a pending driver. Sets status to 'active'.
 * @param {string} driverUid
 * @returns {{ success: boolean }}
 */
export async function approveDriver(driverUid) {
    try {
        await setDoc(doc(db, 'users', driverUid), { status: 'active' }, { merge: true });
        return { success: true };
    } catch (err) {
        console.warn('Failed to approve driver:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Reject a pending driver. Sets status to 'rejected'.
 * @param {string} driverUid
 * @returns {{ success: boolean }}
 */
export async function rejectDriver(driverUid) {
    try {
        await setDoc(doc(db, 'users', driverUid), { status: 'rejected' }, { merge: true });
        return { success: true };
    } catch (err) {
        console.warn('Failed to reject driver:', err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Get ALL users from Firestore.
 * @returns {Promise<Array>}
 */
export async function getAllUsers() {
    try {
        const snapshot = await getDocs(collection(db, 'users'));
        return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('Failed to fetch all users:', err.message);
        return [];
    }
}

/**
 * Get all drivers (any status).
 * @returns {Promise<Array>}
 */
export async function getAllDrivers() {
    try {
        const q = query(collection(db, 'users'), where('role', '==', ROLES.DRIVER));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('Failed to fetch drivers:', err.message);
        return [];
    }
}

/**
 * Get all managers.
 * @returns {Promise<Array>}
 */
export async function getAllManagers() {
    try {
        const q = query(collection(db, 'users'), where('role', '==', ROLES.MANAGER));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (err) {
        console.warn('Failed to fetch managers:', err.message);
        return [];
    }
}

/**
 * Update any user's status (admin action).
 * @param {string} uid
 * @param {string} status - 'active'|'pending'|'rejected'|'suspended'
 */
export async function updateUserStatus(uid, status) {
    try {
        await setDoc(doc(db, 'users', uid), { status }, { merge: true });
        return { success: true };
    } catch (err) {
        return { success: false, error: err.message };
    }
}

// ─── LOGOUT ─────────────────────────────────────────────────────────────

export async function logout() {
    try { await fbSignOut(auth); } catch (e) { /* ignore in demo */ }
    currentUser = null;
    currentRole = null;
    if (authChangeCallback) authChangeCallback(null, null);
}

// ─── HELPERS ────────────────────────────────────────────────────────────

/**
 * Look up a user's Firestore profile.
 * @param {string} uid
 */
async function getUserProfile(uid) {
    try {
        const { getDoc } = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js');
        const snap = await getDoc(doc(db, 'users', uid));
        return snap.exists() ? snap.data() : null;
    } catch (err) {
        console.warn('Failed to get user profile:', err.message);
        return null;
    }
}

function inferRole(input) {
    const lower = (input || '').toLowerCase();
    if (lower.includes('admin')) return ROLES.ADMIN;
    if (lower.includes('manager') || lower.includes('site')) return ROLES.MANAGER;
    return ROLES.DRIVER;
}

// Getters
export function getUser() { return currentUser; }
export function getRole() { return currentRole; }
export function getAdminEmail() { return ADMIN_EMAIL; }
