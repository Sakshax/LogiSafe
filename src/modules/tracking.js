/**
 * tracking.js — Live Geolocation & 500m Geofencing Module (Realtime v2)
 *
 * Provides start/stop tracking, distance computation via Haversine,
 * a geofence alert system when the driver approaches a site,
 * and a realtime listener for all active truck positions (for manager map).
 */

import { calculateDistance } from '../utils/haversine.js';
import { db, doc, setDoc, addDoc, serverTimestamp, collection, onSnapshot, deleteDoc } from '../config/firebase-config.js';

// ─── Constants ──────────────────────────────────────────────────────────
const GEOFENCE_RADIUS_KM = 0.5; // 500 meters
const ACTIVE_TRUCKS_COLLECTION = 'activeTrucks';

// ─── Module State ───────────────────────────────────────────────────────
let watchId = null;
let hasTriggeredGeofence = false;
let destinationCoords = { lat: 19.2813, lng: 72.8808 };
let simulationInterval = null;
let currentTrackingId = null; // Store active session ID for cleanup
let lastLat = null;
let lastLng = null;

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
    currentTrackingId = driverId;
    lastLat = null;
    lastLng = null;

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
    // Avoid jitter: Only process if movement is > 10 meters (0.01 km) or if it's the first ping
    if (lastLat !== null && lastLng !== null) {
        const movedKm = calculateDistance(lastLat, lastLng, lat, lng);
        if (movedKm < 0.01) return; // Haven't really moved
    }

    lastLat = lat;
    lastLng = lng;

    // Sync to Firestore (best-effort)
    try {
        const driverRef = doc(db, ACTIVE_TRUCKS_COLLECTION, driverId);
        await setDoc(driverRef, {
            lat,
            lng,
            driverId,
            destLat: destinationCoords.lat,
            destLng: destinationCoords.lng,
            lastUpdate: serverTimestamp()
        }, { merge: true });
    } catch (e) {
        // Silent fail — Firestore may not be configured
    }

    const distanceKm = calculateDistance(lat, lng, destinationCoords.lat, destinationCoords.lng);

    if (onPositionUpdate) onPositionUpdate(distanceKm, lat, lng);

    // Geofence check
    if (distanceKm <= GEOFENCE_RADIUS_KM && !hasTriggeredGeofence) {
        hasTriggeredGeofence = true;
        
        // Push Real-time Alert to Manager
        try {
            await addDoc(collection(db, 'live_alerts'), {
                type: 'geofence_entry',
                driverId: driverId,
                title: `Arrving: ${driverId}`,
                detail: `Driver has entered the 500m geofence.`,
                lat: lat,
                lng: lng,
                time: serverTimestamp(),
                severity: 'info'
            });
        } catch (e) {}

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
 * Optionally removes the truck from the activeTrucks collection.
 * @param {string} [driverId] - If provided, removes the truck doc from Firestore
 */
export async function stopTracking(driverId) {
    const idToClean = driverId || currentTrackingId;

    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }
    if (simulationInterval !== null) {
        clearInterval(simulationInterval);
        simulationInterval = null;
    }
    hasTriggeredGeofence = false;
    lastLat = null;
    lastLng = null;

    // Remove this truck from activeTrucks so the manager map clears it
    if (idToClean) {
        try {
            await deleteDoc(doc(db, ACTIVE_TRUCKS_COLLECTION, idToClean));
        } catch (e) {
            // Silent fail
        }
    }
    
    if (!driverId || driverId === currentTrackingId) {
        currentTrackingId = null;
    }
}

/**
 * Check if tracking is currently active.
 */
export function isTrackingActive() {
    return watchId !== null || simulationInterval !== null;
}

// ─── REALTIME LISTENER: Active Trucks (for Manager Map) ─────────────────

/**
 * Subscribe to real-time updates of all active truck positions from Firestore.
 * The manager's live map uses this to show/move/remove truck markers dynamically.
 *
 * @param {Function} callback - (trucks: Array<{ id, lat, lng, driverId, lastUpdate }>) => void
 * @returns {Function} unsubscribe function to stop listening
 */
export function listenToActiveTrucks(callback) {
    try {
        const trucksRef = collection(db, ACTIVE_TRUCKS_COLLECTION);

        const unsubscribe = onSnapshot(trucksRef, (snapshot) => {
            const trucks = [];
            const now = new Date();
            const staleThresholdMs = 2 * 60 * 1000; // 2 minutes

            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                const lastUpdate = data.lastUpdate?.toDate ? data.lastUpdate.toDate() : new Date();
                
                // Only include trucks updated within the last 2 minutes
                if (now - lastUpdate < staleThresholdMs) {
                    trucks.push({
                        id: docSnap.id,
                        lat: data.lat,
                        lng: data.lng,
                        destLat: data.destLat,
                        destLng: data.destLng,
                        driverId: data.driverId || docSnap.id,
                        truckId: data.truckId || docSnap.id,
                        driver: data.driver || data.driverId || docSnap.id,
                        lastUpdate: lastUpdate,
                    });
                }
            });

            callback(trucks);
        }, (error) => {
            console.warn('Active trucks subscription error:', error.message);
            callback([]);
        });

        return unsubscribe;
    } catch (err) {
        console.warn('Could not subscribe to active trucks:', err.message);
        callback([]);
        return () => {};
    }
}
