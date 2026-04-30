/**
 * tracking.js — Live Geolocation & 500m Geofencing Module (Realtime v3)
 *
 * REAL GPS ONLY — No simulation, no fake movement.
 * 
 * tracking.js — Real-Time GPS Tracking Module v4
 *
 * This module handles the Driver’s device GPS tracking loop.
 * v4: Prevents double-start leaks, enriches activeTrucks with driver metadata,
 *     improves geofence alert data, adds lastUpdate to user document.
 */

import { db, collection, doc, setDoc, deleteDoc, onSnapshot, serverTimestamp, Timestamp, addDoc } from '../config/firebase-config.js';
import { calculateDistance } from '../utils/haversine.js';

// ─── Constants ──────────────────────────────────────────────────────────
const GEOFENCE_RADIUS_KM = 0.5; // 500 meters
const ACTIVE_TRUCKS_COLLECTION = 'activeTrucks';

// ─── Module State ───────────────────────────────────────────────────────
let watchId = null;
let hasTriggeredGeofence = false;
let destinationCoords = { lat: 19.2813, lng: 72.8808 };
let currentDriverId = null;
let driverName = null;
let driverTruckLicense = null;
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
 * Configure driver metadata for tracking alerts and map labels.
 */
export function setDriverMetadata(name, truckLicense) {
    driverName = name;
    driverTruckLicense = truckLicense;
}

/**
 * Returns the current geofence threshold in km.
 */
export function getGeofenceRadius() {
    return GEOFENCE_RADIUS_KM;
}

/**
 * Start real-time GPS tracking for a driver.
 * Prevents double-start by stopping any existing tracking first.
 */
export function startTracking(driverId, onPositionUpdate, onGeofenceEnter, onError) {
    // Prevent double-start leak: clean up any existing watch
    if (watchId !== null) {
        console.warn('startTracking: Stopping existing tracking before restarting.');
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
    }

    if (!("geolocation" in navigator)) {
        if (onError) onError("Geolocation is not supported by this browser.");
        return;
    }

    currentDriverId = driverId;
    hasTriggeredGeofence = false;
    lastLat = null;
    lastLng = null;

    watchId = navigator.geolocation.watchPosition(
        async (position) => {
            await processPosition(position, driverId, onPositionUpdate, onGeofenceEnter);
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
async function processPosition(position, driverId, onPositionUpdate, onGeofenceEnter) {
    const { latitude: lat, longitude: lng, accuracy } = position.coords;

    // Jitter filter: ignore if moved less than 5 meters
    if (lastLat !== null && lastLng !== null) {
        const movedKm = calculateDistance(lastLat, lastLng, lat, lng);
        if (movedKm < 0.005) return; // < 5 meters, skip this update
    }

    lastLat = lat;
    lastLng = lng;

    // Sync real position to Firestore — this is what the Manager map reads
    try {
        await setDoc(doc(db, ACTIVE_TRUCKS_COLLECTION, driverId), {
            lat, 
            lng, 
            accuracy,
            driver: driverName || 'Unknown',
            truckLicense: driverTruckLicense || 'Unknown',
            driverId: driverId,
            destLat: destinationCoords.lat,
            destLng: destinationCoords.lng,
            lastUpdate: serverTimestamp()
        });
    } catch (e) {
        console.warn('Failed to update activeTrucks:', e.message);
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
                driverName: driverName || 'Driver',
                title: `${driverName || 'Driver'} Arriving`,
                detail: `${driverName || 'Driver'} (${driverTruckLicense || driverId}) is ${(distanceKm * 1000).toFixed(0)}m from destination.`,
                lat: lat,
                lng: lng,
                time: Timestamp.now(),
                severity: 'warning'
            });
        } catch (e) {
            console.warn('Failed to log geofence alert:', e.message);
        }

        if (onGeofenceEnter) onGeofenceEnter(distanceKm);
    }
}

/**
 * Stop GPS tracking and clean up Firestore entry.
 * @param {string} [driverId] - If provided, removes the truck doc from Firestore
 */
export async function stopTracking(driverId) {
    const idToClean = driverId || currentDriverId;

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
            console.warn('Failed to remove activeTruck:', e.message);
        }
    }
    
    if (!driverId || driverId === currentDriverId) {
        currentDriverId = null;
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
