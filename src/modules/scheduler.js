/**
 * scheduler.js — Conflict Detection Engine v3 (Fully Realtime)
 *
 * Implements "Critical Section" logic for narrow roads.
 * On conflict, calculates and returns the NEXT AVAILABLE 30-minute slot.
 * All bookings are persisted to Firestore with real-time subscriptions.
 * Local state kept as a synchronized cache from Firestore snapshots.
 */

import { db, collection, query, where, getDocs, addDoc, Timestamp, deleteDoc, doc, onSnapshot, orderBy } from '../config/firebase-config.js';
import { to12Hour, todayISO } from '../utils/formatters.js';

// ─── Constants ──────────────────────────────────────────────────────────
const BOOKINGS_COLLECTION = 'logistics_slots';
const NARROW_ROAD_LIMIT = 1;
const SLOT_INTERVAL_MINUTES = 30;
const DAY_START_HOUR = 7;   // 07:00 AM
const DAY_END_HOUR = 18;    // 06:00 PM (last slot at 05:30 PM)

// ─── Local State (synced from Firestore snapshots) ──────────────────────
let localBookings = [];

// ─── Time Utility Helpers ───────────────────────────────────────────────

/**
 * Generate all possible 30-minute time slots for the day.
 * @returns {string[]} e.g. ["07:00", "07:30", "08:00", ...]
 */
function generateAllSlots() {
    const slots = [];
    for (let h = DAY_START_HOUR; h < DAY_END_HOUR; h++) {
        slots.push(`${String(h).padStart(2, '0')}:00`);
        slots.push(`${String(h).padStart(2, '0')}:30`);
    }
    return slots;
}

/**
 * Find the next available 30-minute slot for a given road and date,
 * starting from the requested time.
 *
 * @param {string} road
 * @param {string} date - YYYY-MM-DD
 * @param {string} requestedTime - "HH:MM"
 * @returns {{ found: boolean, time: string|null, display: string|null }}
 */
function findNextAvailableSlot(road, date, requestedTime) {
    const allSlots = generateAllSlots();
    const occupiedTimes = new Set(
        localBookings
            .filter(b => b.road === road && b.date === date)
            .map(b => b.time)
    );

    // Find the index of the requested time (or the first slot after it)
    let startIdx = allSlots.findIndex(s => s >= requestedTime);
    if (startIdx === -1) startIdx = 0;

    // Search forward from the NEXT slot after the requested one
    for (let i = startIdx + 1; i < allSlots.length; i++) {
        if (!occupiedTimes.has(allSlots[i])) {
            return { found: true, time: allSlots[i], display: to12Hour(allSlots[i]) };
        }
    }

    // If no forward slot found, wrap around from the beginning (before requested time)
    for (let i = 0; i < startIdx; i++) {
        if (!occupiedTimes.has(allSlots[i])) {
            return { found: true, time: allSlots[i], display: to12Hour(allSlots[i]) };
        }
    }

    // Entire day fully booked
    return { found: false, time: null, display: null };
}

/**
 * Subscribe to real-time booking updates from Firestore for a given date.
 * Calls the callback with the latest array of bookings every time the data changes.
 *
 * @param {string} date - YYYY-MM-DD date string to filter bookings
 * @param {Function} callback - (bookings: Array) => void
 * @returns {Function} unsubscribe function
 */
export function subscribeToBookings(date, callback) {
    try {
        const slotsRef = collection(db, BOOKINGS_COLLECTION);
        const q = query(slotsRef, where('date', '==', date));

        const unsubscribe = onSnapshot(q, (snapshot) => {
            const bookings = [];
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                bookings.push({
                    id: docSnap.id,
                    truckId: data.truckId || '',
                    targetSite: data.targetSite || '',
                    road: data.road || '',
                    date: data.date || '',
                    time: data.time || '',
                    status: data.status || 'PENDING_ADMIN',
                    driver: data.driver || 'Pending Assignment',
                    customAddress: data.customAddress || '',
                    customLat: data.customLat || null,
                    customLng: data.customLng || null,
                    createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(),
                });
            });

            // Sort by time
            bookings.sort((a, b) => a.time.localeCompare(b.time));

            // Update local cache
            // Remove old entries for this date and replace with fresh snapshot
            localBookings = localBookings.filter(b => b.date !== date);
            localBookings.push(...bookings);

            callback(bookings);
        }, (error) => {
            console.warn('Firestore bookings subscription error:', error.message);
            // Return whatever we have locally
            callback(localBookings.filter(b => b.date === date));
        });

        return unsubscribe;
    } catch (err) {
        console.warn('Could not subscribe to bookings:', err.message);
        // Immediate callback with empty
        callback([]);
        return () => {};
    }
}

/**
 * Subscribe to ALL bookings (no date filter) for admin views.
 *
 * @param {Function} callback - (bookings: Array) => void
 * @returns {Function} unsubscribe function
 */
export function subscribeToAllBookings(callback) {
    try {
        const slotsRef = collection(db, BOOKINGS_COLLECTION);

        const unsubscribe = onSnapshot(slotsRef, (snapshot) => {
            const bookings = [];
            snapshot.forEach((docSnap) => {
                const data = docSnap.data();
                bookings.push({
                    id: docSnap.id,
                    truckId: data.truckId || '',
                    targetSite: data.targetSite || '',
                    road: data.road || '',
                    date: data.date || '',
                    time: data.time || '',
                    status: data.status || 'PENDING_ADMIN',
                    driver: data.driver || 'Pending Assignment',
                    customAddress: data.customAddress || '',
                    customLat: data.customLat || null,
                    customLng: data.customLng || null,
                    createdAt: data.createdAt?.toDate ? data.createdAt.toDate() : new Date(),
                });
            });

            bookings.sort((a, b) => {
                const dateCmp = a.date.localeCompare(b.date);
                return dateCmp !== 0 ? dateCmp : a.time.localeCompare(b.time);
            });

            // Replace full local cache
            localBookings = bookings;

            callback(bookings);
        }, (error) => {
            console.warn('Firestore all-bookings subscription error:', error.message);
            callback([...localBookings]);
        });

        return unsubscribe;
    } catch (err) {
        console.warn('Could not subscribe to all bookings:', err.message);
        callback([]);
        return () => {};
    }
}

/**
 * Try to book a delivery slot.
 * Applies Conflict Detection: blocks overlapping slots on the same road.
 * On conflict, returns the next available 30-minute slot suggestion.
 *
 * @param {Object} booking - { truckId, targetSite, road, date, time, driver }
 * @returns {{
 *   success: boolean,
 *   status: 'booked'|'conflict'|'full',
 *   message: string,
 *   suggestedTime?: string,
 *   suggestedTimeRaw?: string,
 *   conflictingTruck?: string,
 *   booking?: Object
 * }}
 */
export async function bookDeliverySlot(booking) {
    const { truckId, targetSite, road, date, time, driver } = booking;

    // ── Conflict Detection: same road + same date + same time ───────
    const conflict = localBookings.find(
        b => b.road === road && b.date === date && b.time === time
    );

    if (conflict) {
        // Calculate next available slot
        const nextSlot = findNextAvailableSlot(road, date, time);

        if (nextSlot.found) {
            return {
                success: false,
                status: 'conflict',
                message: `Road "${road}" already has truck ${conflict.truckId} (${conflict.driver}) scheduled at ${to12Hour(time)}.`,
                conflictingTruck: conflict.truckId,
                suggestedTime: nextSlot.display,
                suggestedTimeRaw: nextSlot.time
            };
        } else {
            return {
                success: false,
                status: 'full',
                message: `Road "${road}" is fully booked for ${date}. All time slots are occupied.`,
                conflictingTruck: conflict.truckId
            };
        }
    }

    // ── Firestore: Double-check + persist ────────────────────────────
    try {
        const slotsRef = collection(db, BOOKINGS_COLLECTION);
        const q = query(slotsRef, where('road', '==', road), where('date', '==', date), where('time', '==', time));
        const snapshot = await getDocs(q);

        if (snapshot.docs.length >= NARROW_ROAD_LIMIT) {
            const nextSlot = findNextAvailableSlot(road, date, time);
            return {
                success: false,
                status: nextSlot.found ? 'conflict' : 'full',
                message: `Road "${road}" is at capacity for ${to12Hour(time)} on ${date} (Firestore verified).`,
                suggestedTime: nextSlot.display,
                suggestedTimeRaw: nextSlot.time
            };
        }

        const status = driver ? 'SCHEDULED' : 'PENDING_ADMIN';
        const docRef = await addDoc(slotsRef, {
            truckId: truckId || 'Pending Assignment', 
            targetSite, road, date, time, 
            driver: driver || '',
            customAddress: booking.customAddress || '',
            customLat: booking.customLat || null,
            customLng: booking.customLng || null,
            status: status,
            createdAt: Timestamp.now()
        });

        // The onSnapshot listener will automatically pick up this new booking
        // and update the UI. No need to manually push to localBookings.

        return {
            success: true,
            status: 'requested',
            message: `Slot requested successfully! Request sent to Admin for driver assignment at ${to12Hour(time)}.`,
            booking: { id: docRef.id, truckId: truckId || 'Pending', targetSite, road, date, time, driver: driver || '', status: status, createdAt: new Date() }
        };
    } catch (err) {
        console.warn('Firestore write failed, saving locally:', err.message);

        // Fallback: local-only booking
        const newBooking = {
            id: `local-${Date.now()}`,
            truckId: truckId || 'Pending Assignment', targetSite, road, date, time, driver: driver || '',
            status: driver ? 'SCHEDULED' : 'PENDING_ADMIN',
            createdAt: new Date()
        };
        localBookings.push(newBooking);

        return {
            success: true,
            status: 'requested',
            message: `Slot requested locally at ${to12Hour(time)}. (Offline mode)`,
            booking: newBooking
        };
    }
}

/**
 * Cancel a booking by ID (removes from Firestore + local cache).
 */
export async function cancelBooking(bookingId) {
    // Remove locally
    localBookings = localBookings.filter(b => b.id !== bookingId);

    // Remove from Firestore
    try {
        await deleteDoc(doc(db, BOOKINGS_COLLECTION, bookingId));
    } catch (e) {
        console.warn('Could not delete from Firestore:', e.message);
    }
}

/**
 * Get all bookings from local cache, optionally filtered.
 * (Primarily used as a synchronous read of the cached data)
 */
export function getBookings({ date, targetSite, road } = {}) {
    let result = [...localBookings];
    if (date) result = result.filter(b => b.date === date);
    if (targetSite) result = result.filter(b => b.targetSite === targetSite);
    if (road) result = result.filter(b => b.road === road);
    return result.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Update booking status in Firestore + local cache.
 */
export async function updateBookingStatus(bookingId, status) {
    const booking = localBookings.find(b => b.id === bookingId);
    if (booking) booking.status = status;

    // Sync to Firestore
    try {
        const { setDoc, doc: firestoreDoc } = await import('../config/firebase-config.js');
        await setDoc(firestoreDoc(db, BOOKINGS_COLLECTION, bookingId), { status }, { merge: true });
    } catch (e) {
        console.warn('Could not update status in Firestore:', e.message);
    }

    return booking;
}

export async function assignDriverAndSendLink(bookingId, driver, truckId) {
    const trackingToken = btoa(`booking_${bookingId}`);
    try {
        const { setDoc, doc: firestoreDoc } = await import('../config/firebase-config.js');
        await setDoc(firestoreDoc(db, BOOKINGS_COLLECTION, bookingId), { 
            status: 'SCHEDULED', 
            driver: driver,
            truckId: truckId,
            trackingToken: trackingToken
        }, { merge: true });
    } catch (e) {
        console.warn('Could not assign driver in Firestore:', e.message);
    }
    return trackingToken;
}
