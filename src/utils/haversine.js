/**
 * haversine.js — GPS Distance Utility
 * Calculates the great-circle distance between two points on Earth.
 */

const EARTH_RADIUS_KM = 6371;

/**
 * Convert degrees to radians
 * @param {number} deg
 * @returns {number}
 */
const toRad = (deg) => deg * (Math.PI / 180);

/**
 * Calculates distance between two GPS coordinates using the Haversine formula.
 * @param {number} lat1
 * @param {number} lon1
 * @param {number} lat2
 * @param {number} lon2
 * @returns {number} Distance in kilometers
 */
export function calculateDistance(lat1, lon1, lat2, lon2) {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;

    return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
