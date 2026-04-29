/**
 * tracking.js — Live Geolocation & 500m Geofencing Module (Realtime v3)
 *
 * REAL GPS ONLY — No simulation, no fake movement.
 * 
 * Provides start/stop tracking, distance computation via Haversine,
 * a geofence alert system when the driver approaches a site,
 * and a realtime listener for all active truck positions (for manager map).
 *
 * How it works for the Manager Map:
 *  - Driver's watchPosition fires → processPosition writes {lat, lng} to Firestore
 *  - Manager's onSnapshot listener picks up the new {lat, lng} instantly
 *  - Manager map moves the truck marker to the new coordinates
 *  - If driver stops moving → no new writes → marker stays still
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
let currentTrackingId = null;
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
 * Start continuous GPS tracking using the device's real location.
 * NO SIMULATION. If geolocation is unavailable, an error is reported.
 *
 * @param {string} driverId - Unique identifier for this driver session (Firebase UID)
 * @param {Function} onPositionUpdate - (distanceKm, lat, lng) => void
 * @param {Function} onGeofenceEnter - (distanceKm) => void — fires once when within 500m
 * @param {Function} onError - (errorMsg) => void
 */
export function startTracking(driverId, onPositionUpdate, onGeofenceEnter, onError) {
    if (!("geolocation" in navigator)) {
        if (onError) onError("Geolocation is not supported by this browser.");
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
            console.warn('Geolocation error:', err.message);
            if (onError) onError(err.message);
        },
        { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
    );
}

/**
 * Process a new GPS position — compute distance, sync to Firestore, evaluate geofence.
 *
 * Jitter filter: ignores movements < 5 meters to avoid GPS drift while stationary.
 * But the FIRST position is always processed immediately so the truck appears on the map right away.
 */
async function processPosition(driverId, lat, lng, onPositionUpdate, onGeofenceEnter) {
    // Jitter filter: skip if moved < 5 meters (0.005 km), but always process first ping
    if (lastLat !== null && lastLng !== null) {
        const movedKm = calculateDistance(lastLat, lastLng, lat, lng);
        if (movedKm < 0.005) return; // Haven't really moved (GPS drift)
    }

    lastLat = lat;
    lastLng = lng;

    // Sync real position to Firestore — this is what the Manager map reads
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
                title: `Arriving: ${driverId}`,
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
 * Stop GPS tracking and clean up Firestore entry.
 * @param {string} [driverId] - If provided, removes the truck doc from Firestore
 */
export async function stopTracking(driverId) {
    const idToClean = driverId || currentTrackingId;

    if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
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
    return watchId !== null;
}

// ─── REALTIME LISTENER: Active Trucks (for Manager Map) ─────────────────

/**
 * Subscribe to real-time updates of all active truck positions from Firestore.
 * The manager's live map uses this to show/move/remove truck markers dynamically.
 *
 * How real-time movement works:
 *  - Driver's GPS fires watchPosition → processPosition writes to Firestore
 *  - This onSnapshot fires immediately with the new lat/lng
 *  - reconcileTruckMarkers in manager-view.js moves the Leaflet marker
 *  - If driver stops → no Firestore write → no snapshot → marker stays still
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
            const staleThresholdMs = 5 * 60 * 1000; // 5 minutes (was 2, increased for real GPS which may have gaps)

            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                const lastUpdate = data.lastUpdate?.toDate ? data.lastUpdate.toDate() : new Date();
                
                // Only include trucks updated within the last 5 minutes
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
