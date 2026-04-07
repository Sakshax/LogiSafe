/**
 * tracking.js — Live Geolocation & 500m Geofencing Module
 *
 * Provides start/stop tracking, distance computation via Haversine,
 * and a geofence alert system when the driver approaches a site.
 */

import { calculateDistance } from '../utils/haversine.js';
import { db, doc, setDoc, serverTimestamp } from '../config/firebase-config.js';

// ─── Constants ──────────────────────────────────────────────────────────
const GEOFENCE_RADIUS_KM = 0.5; // 500 meters

// ─── Module State ───────────────────────────────────────────────────────
let watchId = null;
let hasTriggeredGeofence = false;
let destinationCoords = { lat: 19.2813, lng: 72.8808 };
let simulationInterval = null;

/**
 * Set the destination site coordinates for geofencing.
 * @param {{ lat: number, lng: number }} coords
 */
export function setDestination(coords) {
    destinationCoords = coords;
}

/**
 * Returns the current geofence threshold in km.
 */
export function getGeofenceRadius() {
    return GEOFENCE_RADIUS_KM;
}

/**
 * Start continuous GPS tracking.
 *
 * @param {string} driverId - Unique identifier for this driver session
 * @param {Function} onPositionUpdate - (distanceKm, lat, lng) => void
 * @param {Function} onGeofenceEnter - (distanceKm) => void — fires once when within 500m
 * @param {Function} onError - (errorMsg) => void
 */
export function startTracking(driverId, onPositionUpdate, onGeofenceEnter, onError) {
    if (!("geolocation" in navigator)) {
        if (onError) onError("Geolocation is not supported by this browser.");
        // Fallback to simulation
        startSimulation(driverId, onPositionUpdate, onGeofenceEnter);
        return;
    }

    hasTriggeredGeofence = false;

    watchId = navigator.geolocation.watchPosition(
        async (position) => {
            const { latitude: lat, longitude: lng } = position.coords;
            await processPosition(driverId, lat, lng, onPositionUpdate, onGeofenceEnter);
        },
        (err) => {
            console.warn('Geolocation error, falling back to simulation:', err.message);
            if (onError) onError(err.message);
            // Auto-start simulation as fallback
            startSimulation(driverId, onPositionUpdate, onGeofenceEnter);
        },
        { enableHighAccuracy: true, maximumAge: 0, timeout: 10000 }
    );
}

/**
 * Process a new GPS position — compute distance, sync, evaluate geofence.
 */
async function processPosition(driverId, lat, lng, onPositionUpdate, onGeofenceEnter) {
    // Sync to Firestore (best-effort)
    try {
        const driverRef = doc(db, 'activeTrucks', driverId);
        await setDoc(driverRef, { lat, lng, lastUpdate: serverTimestamp() }, { merge: true });
    } catch (e) {
        // Silent fail — Firestore may not be configured
    }

    const distanceKm = calculateDistance(lat, lng, destinationCoords.lat, destinationCoords.lng);

    if (onPositionUpdate) onPositionUpdate(distanceKm, lat, lng);

    // Geofence check
    if (distanceKm <= GEOFENCE_RADIUS_KM && !hasTriggeredGeofence) {
        hasTriggeredGeofence = true;
        if (onGeofenceEnter) onGeofenceEnter(distanceKm);
    }
}

/**
 * Simulated tracking for demo/desktop usage.
 * Animates the truck approaching the destination progressively.
 */
function startSimulation(driverId, onPositionUpdate, onGeofenceEnter) {
    let simLat = destinationCoords.lat + 0.025; // ~2.5 km north
    let simLng = destinationCoords.lng - 0.015;
    const stepLat = 0.0012;
    const stepLng = 0.0007;

    simulationInterval = setInterval(async () => {
        simLat -= stepLat;
        simLng += stepLng;

        // Add small random jitter for realism
        const jitterLat = (Math.random() - 0.5) * 0.0002;
        const jitterLng = (Math.random() - 0.5) * 0.0002;

        await processPosition(
            driverId,
            simLat + jitterLat,
            simLng + jitterLng,
            onPositionUpdate,
            onGeofenceEnter
        );
    }, 2000);
}

/**
 * Stop all tracking (both real and simulated).
 */
export function stopTracking() {
    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (simulationInterval !== null) {
        clearInterval(simulationInterval);
        simulationInterval = null;
    }
    hasTriggeredGeofence = false;
}

/**
 * Check if tracking is currently active.
 */
export function isTrackingActive() {
    return watchId !== null || simulationInterval !== null;
}
