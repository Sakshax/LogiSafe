/**
 * formatters.js — Date/Time and string formatting helpers
 */

/**
 * Format a Date object to a human-readable time string
 * @param {Date} date
 * @returns {string} e.g. "02:30 PM"
 */
export function formatTime(date) {
    return date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
}

/**
 * Format a Date object to a human-readable date string
 * @param {Date} date
 * @returns {string} e.g. "08 Apr 2026"
 */
export function formatDate(date) {
    return date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

/**
 * Get "X mins ago" style relative time
 * @param {Date} past
 * @returns {string}
 */
export function timeAgo(past) {
    const seconds = Math.floor((Date.now() - past.getTime()) / 1000);
    if (seconds < 10) return `Just now`;
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Convert a 24h time string (e.g. "14:00") to 12h display
 * @param {string} time24 - "HH:MM"
 * @returns {string} - "02:00 PM"
 */
export function to12Hour(time24) {
    const [h, m] = time24.split(':').map(Number);
    const suffix = h >= 12 ? 'PM' : 'AM';
    const hour12 = h % 12 || 12;
    return `${String(hour12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${suffix}`;
}

/**
 * Generate today's date as YYYY-MM-DD
 * @returns {string}
 */
export function todayISO() {
    return new Date().toISOString().split('T')[0];
}
