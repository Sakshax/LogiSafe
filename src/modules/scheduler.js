/**
 * scheduler.js — Conflict Detection Engine
 *
 * Implements "Critical Section" logic for narrow roads.
 * Validates time-slot availability against in-memory state AND Firestore.
 * For demo mode (no live Firestore), falls back to local state.
 */

import { db, collection, query, where, getDocs, addDoc, Timestamp, deleteDoc, doc } from '../config/firebase-config.js';
import { to12Hour, todayISO } from '../utils/formatters.js';

// ─── Constants ──────────────────────────────────────────────────────────
const BOOKINGS_COLLECTION = 'logistics_slots';
const NARROW_ROAD_LIMIT = 1; // Max 1 truck per time window per road

// ─── Local State (demo fallback) ────────────────────────────────────────
let localBookings = [];

// Seed some initial demo bookings
export function seedDemoBookings() {
    const today = todayISO();
    localBookings = [
        { id: 'demo-1', truckId: 'MH-04-AB-1234', targetSite: 'site-alpha', road: 'Kashimira Rd', date: today, time: '09:00', status: 'SCHEDULED', driver: 'Rajesh K.', createdAt: new Date(Date.now() - 3600000) },
        { id: 'demo-2', truckId: 'MH-04-CD-5678', targetSite: 'site-alpha', road: 'Kashimira Rd', date: today, time: '11:00', status: 'SCHEDULED', driver: 'Sunil P.',  createdAt: new Date(Date.now() - 7200000) },
        { id: 'demo-3', truckId: 'MH-04-EF-9012', targetSite: 'site-beta',  road: 'Station Rd',   date: today, time: '10:00', status: 'EN_ROUTE',  driver: 'Anil M.',   createdAt: new Date(Date.now() - 1800000) },
        { id: 'demo-4', truckId: 'MH-04-GH-3456', targetSite: 'site-gamma', road: 'Ghodbunder Rd',date: today, time: '14:00', status: 'SCHEDULED', driver: 'Vikram S.', createdAt: new Date(Date.now() - 600000) },
    ];
}

/**
 * Try to book a delivery slot.
 * Applies Conflict Detection: blocks overlapping slots on the same road.
 *
 * @param {Object} booking - { truckId, targetSite, road, date, time, driver }
 * @returns {{ success: boolean, message: string, booking?: Object }}
 */
export async function bookDeliverySlot(booking) {
    const { truckId, targetSite, road, date, time, driver } = booking;

    // ── Conflict Detection: same road + same date + same time ───────
    const conflict = localBookings.find(
        b => b.road === road && b.date === date && b.time === time
    );

    if (conflict) {
        return {
            success: false,
            message: `CONFLICT: Road "${road}" already has truck ${conflict.truckId} scheduled at ${to12Hour(time)} on ${date}. Simultaneous arrivals on narrow roads are prohibited by MBMC policy.`
        };
    }

    // ── Try Firestore (graceful fallback) ───────────────────────────
    try {
        const slotsRef = collection(db, BOOKINGS_COLLECTION);
        const q = query(slotsRef, where('road', '==', road), where('date', '==', date), where('time', '==', time));
        const snapshot = await getDocs(q);

        if (snapshot.docs.length >= NARROW_ROAD_LIMIT) {
            return {
                success: false,
                message: `CONFLICT (Firestore): Road "${road}" is at capacity for ${to12Hour(time)} on ${date}.`
            };
        }

        await addDoc(slotsRef, { truckId, targetSite, road, date, time, driver, status: 'SCHEDULED', createdAt: Timestamp.now() });
    } catch (err) {
        console.warn('Firestore unavailable, booking saved locally:', err.message);
    }

    // ── Local state update ──────────────────────────────────────────
    const newBooking = {
        id: `booking-${Date.now()}`,
        truckId, targetSite, road, date, time, driver,
        status: 'SCHEDULED',
        createdAt: new Date()
    };
    localBookings.push(newBooking);

    return { success: true, message: 'Slot booked successfully!', booking: newBooking };
}

/**
 * Cancel a booking by ID.
 */
export function cancelBooking(bookingId) {
    localBookings = localBookings.filter(b => b.id !== bookingId);
}

/**
 * Get all bookings, optionally filtered by date and/or site.
 */
export function getBookings({ date, targetSite, road } = {}) {
    let result = [...localBookings];
    if (date) result = result.filter(b => b.date === date);
    if (targetSite) result = result.filter(b => b.targetSite === targetSite);
    if (road) result = result.filter(b => b.road === road);
    return result.sort((a, b) => a.time.localeCompare(b.time));
}

/**
 * Update booking status.
 */
export function updateBookingStatus(bookingId, status) {
    const booking = localBookings.find(b => b.id === bookingId);
    if (booking) booking.status = status;
    return booking;
}
