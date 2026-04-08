/**
 * scheduler.js — Conflict Detection Engine v2
 *
 * Implements "Critical Section" logic for narrow roads.
 * On conflict, calculates and returns the NEXT AVAILABLE 30-minute slot.
 * Validates against in-memory state AND Firestore (graceful fallback).
 */

import { db, collection, query, where, getDocs, addDoc, Timestamp, deleteDoc, doc } from '../config/firebase-config.js';
import { to12Hour, todayISO } from '../utils/formatters.js';

// ─── Constants ──────────────────────────────────────────────────────────
const BOOKINGS_COLLECTION = 'logistics_slots';
const NARROW_ROAD_LIMIT = 1;
const SLOT_INTERVAL_MINUTES = 30;
const DAY_START_HOUR = 7;   // 07:00 AM
const DAY_END_HOUR = 18;    // 06:00 PM (last slot at 05:30 PM)

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

    // ── Try Firestore (graceful fallback) ───────────────────────────
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

    return {
        success: true,
        status: 'booked',
        message: `Slot booked successfully! ${truckId} → ${road} at ${to12Hour(time)}.`,
        booking: newBooking
    };
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
