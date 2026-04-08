/**
 * manager-view.js — Site Manager Dashboard Controller v3 (Fully Realtime)
 *
 * Features:
 *  - Live Leaflet.js map with REALTIME inbound truck positions from Firestore
 *  - REALTIME schedule fed by Firestore onSnapshot (no manual refresh needed)
 *  - Slot booking with ENHANCED Conflict Detection:
 *    → On conflict: shows suggested next available 30-min slot
 *    → "Accept Suggestion" auto-books the suggested time
 *  - Live truck count indicator
 */

import { initMaps, DARK_TILE_URL, DARK_TILE_ATTRIBUTION, DEMO_SITES, createSiteIcon, createTruckIcon } from '../config/maps-config.js';
import { bookDeliverySlot, subscribeToBookings } from '../modules/scheduler.js';
import { listenToActiveTrucks } from '../modules/tracking.js';
import { getApprovedDrivers } from '../modules/auth.js';
import { to12Hour, todayISO } from '../utils/formatters.js';

let managerMap = null;
let initialized = false;

// Currently selected site
let selectedSite = DEMO_SITES[0];

// Pending booking context (used when accepting a conflict suggestion)
let pendingBooking = null;

// Cached approved drivers list
let approvedDriversCache = [];

// Realtime subscription unsubscribers
let unsubscribeBookings = null;
let unsubscribeTrucks = null;

// Map marker dictionary for live trucks { truckId: L.marker }
let truckMarkers = {};

export async function initManagerView() {
    if (initialized) return;
    initialized = true;

    // Set today's date label
    const scheduleDateEl = document.getElementById('schedule-date');
    if (scheduleDateEl) {
        scheduleDateEl.textContent = new Date().toLocaleDateString('en-IN', {
            weekday: 'short', day: '2-digit', month: 'short', year: 'numeric'
        });
    }

    bindBookingEvents();
    await loadApprovedDrivers();
    await initLiveMap();
    startRealtimeSchedule();
    startRealtimeTruckTracking();
}

export function destroyManagerView() {
    // Unsubscribe from Firestore listeners
    if (unsubscribeBookings) {
        unsubscribeBookings();
        unsubscribeBookings = null;
    }
    if (unsubscribeTrucks) {
        unsubscribeTrucks();
        unsubscribeTrucks = null;
    }

    // Clean up map
    if (managerMap) {
        managerMap.remove();
        managerMap = null;
    }

    truckMarkers = {};
    initialized = false;
    pendingBooking = null;
}

// ─── Realtime Schedule (Firestore onSnapshot) ───────────────────────────

function startRealtimeSchedule() {
    const today = todayISO();

    // Show loading state
    const container = document.getElementById('manager-slots-list');
    if (container) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-slate-500">
                <span class="inline-block w-6 h-6 border-2 border-slate-600 border-t-blue-400 rounded-full animate-spin mb-3"></span>
                <p class="text-sm">Connecting to live schedule...</p>
            </div>`;
    }

    unsubscribeBookings = subscribeToBookings(today, (liveBookings) => {
        renderSchedule(liveBookings);
    });
}

function renderSchedule(bookings) {
    const container = document.getElementById('manager-slots-list');
    if (!container) return;

    if (!bookings || bookings.length === 0) {
        container.innerHTML = `
            <div class="flex flex-col items-center justify-center py-12 text-slate-500">
                <span class="text-4xl mb-3">📋</span>
                <p class="font-medium">No deliveries scheduled</p>
                <p class="text-sm mt-1">Book a slot to get started</p>
            </div>`;
        return;
    }

    const statusConfig = {
        'SCHEDULED': { bg: 'bg-blue-500/10', text: 'text-blue-400', border: 'border-blue-500/20', dot: 'bg-blue-400', label: 'Scheduled' },
        'EN_ROUTE':  { bg: 'bg-amber-500/10', text: 'text-amber-400', border: 'border-amber-500/20', dot: 'bg-amber-400', label: 'En Route' },
        'ARRIVED':   { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20', dot: 'bg-emerald-400', label: 'Arrived' },
        'COMPLETED': { bg: 'bg-slate-500/10',  text: 'text-slate-400', border: 'border-slate-500/20', dot: 'bg-slate-400', label: 'Completed' },
    };

    container.innerHTML = bookings.map((b, i) => {
        const sc = statusConfig[b.status] || statusConfig['SCHEDULED'];
        return `
        <div class="schedule-item group flex items-center gap-4 p-4 rounded-xl border ${sc.border} ${sc.bg} hover:border-white/10 transition-all duration-300 cursor-default" style="animation-delay: ${i * 60}ms">
            <div class="flex-shrink-0 w-16 text-center">
                <p class="text-lg font-bold text-white">${to12Hour(b.time).split(' ')[0]}</p>
                <p class="text-xs ${sc.text}">${to12Hour(b.time).split(' ')[1]}</p>
            </div>
            <div class="w-px h-10 bg-white/10"></div>
            <div class="flex-1 min-w-0">
                <p class="font-semibold text-white text-sm truncate">${b.truckId}</p>
                <p class="text-xs text-slate-400 mt-0.5">${b.driver || 'Unassigned'} · ${b.road}</p>
            </div>
            <div class="flex items-center gap-2">
                <span class="w-2 h-2 rounded-full ${sc.dot} ${b.status === 'EN_ROUTE' ? 'animate-pulse' : ''}"></span>
                <span class="text-xs font-medium ${sc.text}">${sc.label}</span>
            </div>
        </div>`;
    }).join('');
}

// ─── Realtime Truck Tracking on Map ─────────────────────────────────────

function startRealtimeTruckTracking() {
    if (!managerMap) return;

    unsubscribeTrucks = listenToActiveTrucks((trucks) => {
        updateTruckCountIndicator(trucks.length);
        reconcileTruckMarkers(trucks);
    });
}

/**
 * Update the live truck count badge in the header.
 */
function updateTruckCountIndicator(count) {
    const indicator = document.getElementById('manager-truck-count');
    if (indicator) {
        indicator.textContent = `${count} truck${count !== 1 ? 's' : ''} active`;
    }
}

/**
 * Reconcile the map markers with the latest truck positions from Firestore.
 * - Adds markers for new trucks
 * - Moves markers for existing trucks (smooth transition)
 * - Removes markers for trucks that went offline
 */
function reconcileTruckMarkers(trucks) {
    if (!managerMap) return;

    const currentIds = new Set(trucks.map(t => t.id));

    // Remove markers for trucks that are no longer active
    for (const id of Object.keys(truckMarkers)) {
        if (!currentIds.has(id)) {
            managerMap.removeLayer(truckMarkers[id]);
            delete truckMarkers[id];
        }
    }

    // Add or update markers
    trucks.forEach(truck => {
        if (!truck.lat || !truck.lng) return;

        if (truckMarkers[truck.id]) {
            // Smoothly move existing marker
            truckMarkers[truck.id].setLatLng([truck.lat, truck.lng]);

            // Update popup content
            truckMarkers[truck.id].setPopupContent(`
                <div style="font-family:Inter,sans-serif;padding:6px;min-width:160px">
                    <strong style="font-size:13px">${truck.truckId || truck.id}</strong><br>
                    <span style="color:#666;font-size:12px">Driver: ${truck.driver || 'Unknown'}</span><br>
                    <span style="color:#059669;font-size:12px;font-weight:600">📍 Live tracking</span>
                </div>
            `);
        } else {
            // Create new marker
            const icon = createTruckIcon();
            const marker = L.marker([truck.lat, truck.lng], { icon }).addTo(managerMap);
            marker.bindPopup(`
                <div style="font-family:Inter,sans-serif;padding:6px;min-width:160px">
                    <strong style="font-size:13px">${truck.truckId || truck.id}</strong><br>
                    <span style="color:#666;font-size:12px">Driver: ${truck.driver || 'Unknown'}</span><br>
                    <span style="color:#059669;font-size:12px;font-weight:600">📍 Live tracking</span>
                </div>
            `);
            truckMarkers[truck.id] = marker;
        }
    });
}

// ─── Live Map (Leaflet — FREE) ──────────────────────────────────────────
async function initLiveMap() {
    const mapContainer = document.getElementById('manager-map');
    if (!mapContainer) return;

    try {
        await initMaps();
    } catch (e) {
        mapContainer.innerHTML = `
            <div class="flex items-center justify-center h-full bg-slate-800/50 rounded-xl">
                <div class="text-center p-8">
                    <span class="text-4xl block mb-4">🗺️</span>
                    <p class="text-slate-300 font-medium">Map failed to load</p>
                    <p class="text-slate-500 text-sm mt-2">Check internet connection</p>
                </div>
            </div>`;
        return;
    }

    managerMap = L.map(mapContainer, {
        center: [selectedSite.lat, selectedSite.lng],
        zoom: 14,
        zoomControl: true,
        attributionControl: false
    });

    L.tileLayer(DARK_TILE_URL, {
        attribution: DARK_TILE_ATTRIBUTION,
        maxZoom: 19
    }).addTo(managerMap);

    // Site markers
    DEMO_SITES.forEach(site => {
        const icon = createSiteIcon();
        const marker = L.marker([site.lat, site.lng], { icon }).addTo(managerMap);
        marker.bindPopup(`
            <div style="font-family:Inter,sans-serif;padding:4px">
                <strong style="font-size:13px">${site.name}</strong><br>
                <span style="color:#666;font-size:12px">Road: ${site.road}</span>
            </div>
        `);
    });

    // 500m geofence circle around primary site
    L.circle([selectedSite.lat, selectedSite.lng], {
        radius: 500,
        color: '#3b82f6',
        fillColor: '#3b82f6',
        fillOpacity: 0.08,
        weight: 1,
        dashArray: '6, 4'
    }).addTo(managerMap);

    setTimeout(() => managerMap.invalidateSize(), 200);
}

// ─── Load Approved Drivers for Booking Dropdown ─────────────────────────
async function loadApprovedDrivers() {
    const driverSelect = document.getElementById('bm-driver');
    const driverHint = document.getElementById('bm-driver-hint');
    const truckInput = document.getElementById('bm-truck-id');
    if (!driverSelect) return;

    // Show loading state
    driverSelect.innerHTML = '<option value="" disabled selected>Loading drivers...</option>';
    if (truckInput) { truckInput.value = ''; truckInput.placeholder = 'Select a driver above'; }

    try {
        approvedDriversCache = await getApprovedDrivers();
    } catch (e) {
        approvedDriversCache = [];
    }

    if (approvedDriversCache.length === 0) {
        driverSelect.innerHTML = `
            <option value="" disabled selected>No approved drivers yet</option>
        `;
        if (driverHint) {
            driverHint.classList.remove('hidden');
            driverHint.textContent = 'Drivers must register and be approved by admin first';
        }
    } else {
        driverSelect.innerHTML = `
            <option value="" disabled selected>Select a driver</option>
            ${approvedDriversCache.map(d => `
                <option value="${d.name || d.email}"
                        data-uid="${d.uid}"
                        data-email="${d.email}"
                        data-license="${d.truckLicense || ''}">
                    ${d.name || 'Unnamed'} · ${d.truckLicense || 'No license'}
                </option>
            `).join('')}
        `;
        if (driverHint) {
            driverHint.classList.remove('hidden');
            driverHint.textContent = `${approvedDriversCache.length} approved driver${approvedDriversCache.length > 1 ? 's' : ''} available`;
        }
    }

    // Auto-fill truck license when driver is selected
    driverSelect.addEventListener('change', () => {
        const selectedOpt = driverSelect.options[driverSelect.selectedIndex];
        const license = selectedOpt?.dataset?.license || '';
        if (truckInput) {
            truckInput.value = license;
            truckInput.placeholder = license ? '' : 'No license on file';
        }
    });
}

// ─── Booking Modal ──────────────────────────────────────────────────────
function bindBookingEvents() {
    const modal = document.getElementById('booking-modal');
    const openBtn = document.getElementById('new-booking-btn');
    const cancelBtn = document.getElementById('bm-cancel');
    const confirmBtn = document.getElementById('bm-confirm');
    const dateInput = document.getElementById('bm-date');
    const statusEl = document.getElementById('bm-status');

    if (!openBtn) return;

    // Set default date
    if (dateInput) dateInput.value = todayISO();

    // Populate site select
    const siteSelect = document.getElementById('bm-site');
    if (siteSelect) {
        siteSelect.innerHTML = DEMO_SITES.map(s =>
            `<option value="${s.id}" data-road="${s.road}">${s.name}</option>`
        ).join('');
    }

    openBtn.addEventListener('click', async () => {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        clearConflictUI();
        if (statusEl) { statusEl.classList.add('hidden'); statusEl.textContent = ''; }
        // Refresh driver list each time modal opens
        await loadApprovedDrivers();
    });

    cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        clearConflictUI();
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            clearConflictUI();
        }
    });

    confirmBtn.addEventListener('click', async () => {
        const truckId = document.getElementById('bm-truck-id').value.trim();
        const driverSelect = document.getElementById('bm-driver');
        const driver = driverSelect?.value || '';
        const date = dateInput.value;
        const time = document.getElementById('bm-time').value;
        const siteOpt = siteSelect.options[siteSelect.selectedIndex];
        const targetSite = siteOpt.value;
        const road = siteOpt.dataset.road;

        if (!truckId || !date || !time) {
            showBookingStatus('Please fill in all required fields.', 'error');
            return;
        }

        if (!driver) {
            showBookingStatus('Please assign an approved driver.', 'error');
            return;
        }

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>';
        clearConflictUI();

        const result = await bookDeliverySlot({ truckId, targetSite, road, date, time, driver });

        confirmBtn.disabled = false;
        confirmBtn.innerHTML = 'Confirm Slot';

        if (result.success) {
            showBookingStatus(result.message, 'success');
            // Schedule will auto-update via the realtime subscription — no manual renderSchedule() needed!
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                clearConflictUI();
            }, 1200);
        } else if (result.status === 'conflict' && result.suggestedTimeRaw) {
            // ── CONFLICT WITH SUGGESTION — render conflict prompt ────
            pendingBooking = { truckId, targetSite, road, date, time: result.suggestedTimeRaw, driver };
            renderConflictSuggestion(result);
        } else if (result.status === 'full') {
            // ── ALL SLOTS FULL — no suggestion possible ─────────────
            showBookingStatus(`🚫 ${result.message}`, 'error');
        } else {
            showBookingStatus(result.message, 'error');
        }
    });
}

// ─── Conflict Suggestion UI ─────────────────────────────────────────────

/**
 * Renders the conflict detection prompt with Accept/Cancel buttons.
 * @param {{ message: string, suggestedTime: string, conflictingTruck: string }} result
 */
function renderConflictSuggestion(result) {
    const statusEl = document.getElementById('bm-status');
    if (!statusEl) return;

    statusEl.classList.remove('hidden');
    statusEl.className = 'mt-4 rounded-xl overflow-hidden border border-amber-500/20 animate-[fadeInUp_0.3s_ease-out]';
    statusEl.innerHTML = `
        <!-- Conflict Header -->
        <div class="bg-red-500/10 px-4 py-3 flex items-center gap-3 border-b border-red-500/10">
            <span class="flex-shrink-0 w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center text-sm">🚫</span>
            <div class="flex-1 min-w-0">
                <p class="text-red-400 font-semibold text-sm">Conflict Detected</p>
                <p class="text-slate-400 text-xs mt-0.5 truncate">${result.message}</p>
            </div>
        </div>

        <!-- Suggestion Card -->
        <div class="bg-amber-500/5 px-4 py-4">
            <div class="flex items-center gap-3 mb-4">
                <span class="flex-shrink-0 w-10 h-10 rounded-xl bg-emerald-500/15 border border-emerald-500/20 flex items-center justify-center">
                    <span class="text-emerald-400 text-lg">🕐</span>
                </span>
                <div>
                    <p class="text-slate-300 text-sm font-medium">Next available slot:</p>
                    <p class="text-emerald-400 text-xl font-bold tracking-tight">${result.suggestedTime}</p>
                </div>
            </div>

            <p class="text-slate-500 text-xs mb-4 leading-relaxed">
                The Conflict Detection Engine found a free window on the same road. Book this slot instead?
            </p>

            <!-- Action Buttons -->
            <div class="flex gap-3">
                <button id="bm-accept-suggestion"
                    class="flex-1 flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-500 text-white py-2.5 rounded-xl text-sm font-semibold transition-all active:scale-[0.97] shadow-lg hover:shadow-emerald-500/20">
                    <svg class="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                    Accept ${result.suggestedTime}
                </button>
                <button id="bm-reject-suggestion"
                    class="px-5 py-2.5 text-slate-400 hover:text-white text-sm rounded-xl hover:bg-white/5 transition-all border border-white/5">
                    Cancel
                </button>
            </div>
        </div>
    `;

    // ── Bind suggestion buttons ─────────────────────────────────────
    const acceptBtn = document.getElementById('bm-accept-suggestion');
    const rejectBtn = document.getElementById('bm-reject-suggestion');

    if (acceptBtn) {
        acceptBtn.addEventListener('click', async () => {
            if (!pendingBooking) return;

            acceptBtn.disabled = true;
            acceptBtn.innerHTML = '<span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span> Booking...';

            const result = await bookDeliverySlot(pendingBooking);

            if (result.success) {
                statusEl.className = 'mt-4 p-4 rounded-xl bg-emerald-500/10 border border-emerald-500/20';
                statusEl.innerHTML = `
                    <div class="flex items-center gap-3">
                        <span class="flex-shrink-0 w-8 h-8 rounded-lg bg-emerald-500/20 flex items-center justify-center text-sm">✅</span>
                        <div>
                            <p class="text-emerald-400 font-semibold text-sm">Slot Booked Successfully!</p>
                            <p class="text-slate-400 text-xs mt-0.5">${result.message}</p>
                        </div>
                    </div>
                `;
                // Schedule auto-updates via realtime subscription
                pendingBooking = null;

                const modal = document.getElementById('booking-modal');
                setTimeout(() => {
                    if (modal) {
                        modal.classList.add('hidden');
                        modal.classList.remove('flex');
                    }
                    clearConflictUI();
                }, 1500);
            } else {
                // Edge case: suggested slot also got taken (race condition)
                showBookingStatus(`Suggested slot also taken: ${result.message}`, 'error');
                pendingBooking = null;
            }
        });
    }

    if (rejectBtn) {
        rejectBtn.addEventListener('click', () => {
            clearConflictUI();
            pendingBooking = null;
        });
    }
}

/**
 * Clear the conflict suggestion UI and reset status area.
 */
function clearConflictUI() {
    const statusEl = document.getElementById('bm-status');
    if (statusEl) {
        statusEl.classList.add('hidden');
        statusEl.className = 'hidden mt-4 p-3 rounded-lg text-sm';
        statusEl.innerHTML = '';
    }
    pendingBooking = null;
}

function showBookingStatus(message, type) {
    const el = document.getElementById('bm-status');
    if (!el) return;
    el.classList.remove('hidden');
    el.className = `mt-4 p-3 rounded-lg text-sm font-medium ${
        type === 'success' ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' :
        'bg-red-500/10 text-red-400 border border-red-500/20'
    }`;
    el.textContent = message;
}
