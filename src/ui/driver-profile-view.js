/**
 * driver-profile-view.js — Driver Profile Dashboard
 * 
 * Displays the driver's registered details and provides
 * instructions on how to receive temporary tracking links.
 * 
 * PRODUCTION: Continuously tracks the driver's live GPS location
 * and stores it in the Firestore `users` collection. This enables
 * the admin to see all driver locations and recommend the nearest
 * driver when assigning a booking.
 */

import { getUser } from '../modules/auth.js';
import { db, doc, setDoc, serverTimestamp } from '../config/firebase-config.js';
import { calculateDistance } from '../utils/haversine.js';

let initialized = false;
let locationWatchId = null;
let locationUpdateInterval = null;
let lastSharedLat = null;
let lastSharedLng = null;

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

    // Start continuous GPS location tracking
    startLocationSharing(user.uid);
}

export function destroyDriverProfileView() {
    stopLocationSharing();
    initialized = false;
}

// ─── Live Location Sharing ──────────────────────────────────────────────

/**
 * Starts continuous GPS tracking and stores the driver's position
 * in the Firestore `users/{uid}` document every update.
 * This runs in the background while the driver has the app open.
 */
function startLocationSharing(driverUid) {
    if (!driverUid) return;

    // Update location status UI
    const statusEl = document.getElementById('driver-location-status');
    if (statusEl) {
        statusEl.textContent = 'Requesting location access...';
        statusEl.style.color = '#F4A623';
    }

    if (!('geolocation' in navigator)) {
        if (statusEl) {
            statusEl.textContent = 'Geolocation not supported on this device';
            statusEl.style.color = '#E05535';
        }
        return;
    }

    // Request continuous position updates
    locationWatchId = navigator.geolocation.watchPosition(
        async (position) => {
            const { latitude: lat, longitude: lng, accuracy } = position.coords;

            // Jitter filter: only write if moved more than 10 meters
            if (lastSharedLat !== null && lastSharedLng !== null) {
                const movedKm = calculateDistance(lastSharedLat, lastSharedLng, lat, lng);
                if (movedKm < 0.01) return; // < 10 meters, skip
            }
            lastSharedLat = lat;
            lastSharedLng = lng;
            
            // Update Firestore user document with live location
            // Uses setDoc with merge to handle first-time writes gracefully
            try {
                const userRef = doc(db, 'users', driverUid);
                await setDoc(userRef, {
                    lastLocation: {
                        lat,
                        lng,
                        accuracy: Math.round(accuracy),
                        updatedAt: serverTimestamp()
                    }
                }, { merge: true });
            } catch (e) {
                console.warn('Failed to update driver location:', e.message);
            }

            // Update UI
            if (statusEl) {
                statusEl.innerHTML = `<span style="color:#7A8C3E;">📍 Location sharing active</span> <span style="color:#94A3B8;font-size:9px;">(${lat.toFixed(4)}, ${lng.toFixed(4)} ±${Math.round(accuracy)}m)</span>`;
            }
        },
        (err) => {
            console.warn('Geolocation error:', err.message);
            if (statusEl) {
                statusEl.textContent = 'Location access denied — enable in browser settings';
                statusEl.style.color = '#E05535';
            }
        },
        {
            enableHighAccuracy: true,
            maximumAge: 30000,     // Accept cached position up to 30 sec old
            timeout: 15000         // Wait max 15 sec for a position
        }
    );

    // Also do a periodic forced update every 60 seconds for reliability
    locationUpdateInterval = setInterval(() => {
        navigator.geolocation.getCurrentPosition(
            async (position) => {
                const { latitude: lat, longitude: lng, accuracy } = position.coords;
                try {
                    const userRef = doc(db, 'users', driverUid);
                    await setDoc(userRef, {
                        lastLocation: {
                            lat,
                            lng,
                            accuracy: Math.round(accuracy),
                            updatedAt: serverTimestamp()
                        }
                    }, { merge: true });
                    lastSharedLat = lat;
                    lastSharedLng = lng;
                } catch (e) { /* silent */ }
            },
            () => { /* silent */ },
            { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
        );
    }, 60000);
}

/**
 * Stops all location watching and intervals.
 */
function stopLocationSharing() {
    if (locationWatchId !== null) {
        navigator.geolocation.clearWatch(locationWatchId);
        locationWatchId = null;
    }
    if (locationUpdateInterval !== null) {
        clearInterval(locationUpdateInterval);
        locationUpdateInterval = null;
    }
    lastSharedLat = null;
    lastSharedLng = null;
}
