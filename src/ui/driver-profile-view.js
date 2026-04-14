/**
 * driver-profile-view.js — Driver Profile Dashboard
 * 
 * Simply displays the driver's registered details and provides
 * instructions on how to receive temporary tracking links.
 */

import { getUser } from '../modules/auth.js';

let initialized = false;

export function initDriverProfileView() {
    if (initialized) return;
    initialized = true;

    const user = getUser();
    if (!user) return;

    const nameEl = document.getElementById('profile-driver-name');
    const mobileEl = document.getElementById('profile-mobile');
    const licenseEl = document.getElementById('profile-license');

    if (nameEl) nameEl.textContent = user.displayName || 'Unnamed Driver';
    if (mobileEl) mobileEl.textContent = user.mobile || 'No mobile registered';
    if (licenseEl) licenseEl.textContent = user.truckLicense || 'N/A';
}

export function destroyDriverProfileView() {
    initialized = false;
}
