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

import { initMaps, DARK_TILE_URL, DARK_TILE_ATTRIBUTION, DEMO_SITES, createSiteIcon, createTruckIcon, STANDARD_TILE_URL, STANDARD_TILE_ATTRIBUTION } from '../config/maps-config.js';
import { bookDeliverySlot, subscribeToBookings } from '../modules/scheduler.js';
import { listenToActiveTrucks } from '../modules/tracking.js';
import { getApprovedDrivers } from '../modules/auth.js';
import { to12Hour, todayISO, timeAgo } from '../utils/formatters.js';

let managerMap = null;
let initialized = false;

// Mini-map for location pinning
let miniMap = null;
let miniMapMarker = null;

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
let truckPaths = {}; // Store routing polylines

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
        'SCHEDULED': { text: 'text-[#7A8C3E]', dot: 'bg-[#7A8C3E]', label: 'Scheduled' },
        'EN_ROUTE':  { text: 'text-[#F4A623]', dot: 'bg-[#F4A623]', label: 'En Route' },
        'ARRIVED':   { text: 'text-[#1C1C1C]', dot: 'bg-[#1C1C1C]', label: 'Arrived' },
        'COMPLETED': { text: 'text-[#64748B]', dot: 'bg-[#64748B]', label: 'Completed' },
    };

    container.innerHTML = bookings.map((b, i) => {
        const sc = statusConfig[b.status] || statusConfig['SCHEDULED'];
        const timeStr = to12Hour(b.time);
        return `
        <div class="flex items-center gap-6 p-4 border border-[#1C1C1C]/10 bg-white transition-all duration-300" style="animation-delay: ${i * 60}ms">
            <div class="w-16 text-center border-r border-[#1C1C1C]/10 pr-6">
                <p class="text-[10px] font-extrabold text-[#1C1C1C]">${timeStr.split(' ')[0]}</p>
                <p class="text-[9px] font-bold text-[#64748B] uppercase">${timeStr.split(' ')[1]}</p>
            </div>
            <div class="flex-1 min-w-0">
                <p class="ui-label text-[#7A8C3E] mb-1">/ Tracking Active</p>
                <p class="font-bold text-[#1C1C1C] text-sm uppercase tracking-tight">${b.truckId}</p>
                <p class="text-[10px] text-[#64748B] font-medium mt-1 uppercase tracking-wider">${b.driver || 'No Driver'} · ${b.road}</p>
                ${b.material ? `
                    <div class="mt-2 flex">
                        <span class="px-2 py-0.5 bg-[#F8FAFC] text-[#1C1C1C] text-[9px] font-extrabold uppercase tracking-widest border border-[#1C1C1C]/10">${b.material}</span>
                    </div>
                ` : ''}
            </div>
            <div class="flex items-center gap-2">
                <span class="w-1.5 h-1.5 rounded-full ${sc.dot} ${b.status === 'EN_ROUTE' ? 'animate-pulse' : ''}"></span>
                <span class="ui-label ${sc.text}">${sc.label}</span>
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

    // Realtime Manager Alerts for Geofence
    try {
        const { collection, onSnapshot } = window.firebaseFirestoreVars || {}; // If not available, we use direct import
    } catch(e){}
    import('../config/firebase-config.js').then(({ db, collection, onSnapshot }) => {
        let isInitialLoad = true;
        onSnapshot(collection(db, 'live_alerts'), (snapshot) => {
            if (isInitialLoad) { isInitialLoad = false; return; } // Skip historical alerts
            
            snapshot.docChanges().forEach((change) => {
                if (change.type === 'added') {
                    const data = change.doc.data();
                    if (data.type === 'geofence_entry') {
                        // Display an immediate alert UI overlay to Manager
                        const alertBox = document.createElement('div');
                        alertBox.className = 'fixed top-24 right-8 z-50 bg-[#E05535] text-white p-4 rounded-xl shadow-2xl flex items-center gap-3 max-w-sm animate-bounce';
                        alertBox.innerHTML = `
                            <span class="text-2xl">🚨</span>
                            <div>
                                <p class="font-bold text-sm tracking-widest uppercase mb-1">Driver Approaching</p>
                                <p class="text-xs opacity-90">${data.title}: ${data.detail}</p>
                            </div>
                        `;
                        document.body.appendChild(alertBox);
                        setTimeout(() => alertBox.remove(), 8000);
                    }
                }
            });
        });
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

    // Update or Add
    trucks.forEach(truck => {
        if (!truck.lat || !truck.lng) return;

        const timeStr = truck.lastUpdate ? timeAgo(truck.lastUpdate) : 'Just now';

        const popupContent = `
            <div style="font-family:Inter,sans-serif;padding:6px;min-width:160px">
                <div class="flex items-center gap-2 mb-1">
                    <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                    <strong style="font-size:13px">${truck.truckId || truck.id}</strong>
                </div>
                <div style="color:#666;font-size:11px;margin-bottom:4px">
                    Driver: ${truck.driver || 'Unknown'}
                </div>
                <div style="display:flex;align-items:center;justify-content:between;border-top:1px solid #eee;padding-top:4px;margin-top:4px">
                    <span style="color:#059669;font-size:11px;font-weight:600">LIVE TRACKING</span>
                    <span style="color:#94a3b8;font-size:10px;margin-left:auto">${timeStr}</span>
                </div>
            </div>
        `;

        // Update Marker
        if (truckMarkers[truck.id]) {
            truckMarkers[truck.id].setLatLng([truck.lat, truck.lng]);
            truckMarkers[truck.id].setPopupContent(popupContent);
        } else {
            const icon = createTruckIcon();
            const marker = L.marker([truck.lat, truck.lng], { icon }).addTo(managerMap);
            marker.bindPopup(popupContent);
            truckMarkers[truck.id] = marker;
        }

        // Draw/Update routing path (polyline)
        if (truck.destLat && truck.destLng) {
            const pathPoints = [
                [truck.lat, truck.lng],
                [truck.destLat, truck.destLng]
            ];
            
            if (truckPaths[truck.id]) {
                truckPaths[truck.id].setLatLngs(pathPoints);
            } else {
                truckPaths[truck.id] = L.polyline(pathPoints, {
                    color: '#7A8C3E',
                    weight: 3,
                    opacity: 0.6,
                    dashArray: '8, 8',
                    lineJoin: 'round'
                }).addTo(managerMap);
            }
        }
    });

    // Cleanup markers and paths
    for (const id of Object.keys(truckMarkers)) {
        if (!currentIds.has(id)) {
            managerMap.removeLayer(truckMarkers[id]);
            delete truckMarkers[id];
            
            if (truckPaths[id]) {
                managerMap.removeLayer(truckPaths[id]);
                delete truckPaths[id];
            }
        }
    }
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

    L.tileLayer(STANDARD_TILE_URL, {
        attribution: STANDARD_TILE_ATTRIBUTION,
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
        color: '#7A8C3E',
        fillColor: '#7A8C3E',
        fillOpacity: 0.1,
        weight: 1,
        dashArray: '6, 4'
    }).addTo(managerMap);

    setTimeout(() => managerMap.invalidateSize(), 200);
}

/**
 * Initialize a mini-map inside the booking modal for custom point pinning.
 */
async function initMiniMap() {
    const miniMapContainer = document.getElementById('bm-mini-map');
    if (!miniMapContainer || miniMap) return;

    miniMapContainer.classList.remove('hidden');

    miniMap = L.map(miniMapContainer, {
        center: [selectedSite.lat, selectedSite.lng],
        zoom: 13,
        zoomControl: false,
        attributionControl: false
    });

    // Use STANDARD_TILE_URL for "Colourful" look
    L.tileLayer(STANDARD_TILE_URL, {
        attribution: STANDARD_TILE_ATTRIBUTION,
        maxZoom: 19
    }).addTo(miniMap);

    // Add Heatmap Layer (same logic as Admin Portal)
    const heatData = [];
    DEMO_SITES.forEach(site => {
        // Generate pseudo-random density for visual impact
        for (let i = 0; i < 8; i++) {
            heatData.push([site.lat + (Math.random() - 0.5) * 0.012, site.lng + (Math.random() - 0.5) * 0.012, Math.random() * 0.8 + 0.3]);
        }
    });

    if (window.L && L.heatLayer) {
        L.heatLayer(heatData, { 
            radius: 25, 
            blur: 15, 
            maxZoom: 17, 
            gradient: { 0.2: '#7A8C3E', 0.5: '#F4A623', 0.8: '#E05535', 1.0: '#E05535' } 
        }).addTo(miniMap);
    }

    // Initial Marker (Modern Rounded Pin)
    miniMapMarker = L.marker([selectedSite.lat, selectedSite.lng], {
        draggable: true,
        icon: L.divIcon({
            className: 'pinned-location',
            html: `<div style="width:24px;height:24px;background:#E05535;border:4px solid #fff;border-radius:50%;box-shadow:0 0 20px rgba(224,85,53,0.5);display:flex;align-items:center;justify-content:center;">
                     <div style="width:4px;height:4px;background:#fff;border-radius:50%;"></div>
                   </div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12]
        })
    }).addTo(miniMap);

    // Update coordinates when marker is dragged
    miniMapMarker.on('dragend', () => {
        const pos = miniMapMarker.getLatLng();
        updatePinnedLocation(pos.lat, pos.lng);
    });

    // Handle map clicks to move marker
    miniMap.on('click', (e) => {
        miniMapMarker.setLatLng(e.latlng);
        updatePinnedLocation(e.latlng.lat, e.latlng.lng);
    });
}

async function updatePinnedLocation(lat, lng) {
    const latInput = document.getElementById('bm-lat');
    const lngInput = document.getElementById('bm-lng');
    const pinCoords = document.getElementById('bm-pin-coords');
    const pinStatus = document.getElementById('bm-pin-status');
    const addressInput = document.getElementById('bm-address');

    if (latInput) latInput.value = lat.toFixed(6);
    if (lngInput) lngInput.value = lng.toFixed(6);
    if (pinCoords) pinCoords.textContent = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    if (pinStatus) pinStatus.classList.remove('hidden');

    // Auto-fetch human readable address (Reverse Geocoding)
    if (addressInput) {
        addressInput.placeholder = "Determining delivery address...";
        try {
            const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}`);
            if (!res.ok) throw new Error('Geocoding failed');
            const data = await res.json();
            
            if (data && data.display_name) {
                addressInput.value = data.display_name;
            }
        } catch (e) {
            console.warn('Reverse geocoding failed:', e);
            addressInput.placeholder = "Could not fetch address. Please type manually.";
        }
    }
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

    openBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        clearConflictUI();
        if (statusEl) { statusEl.classList.add('hidden'); statusEl.textContent = ''; }
    });

    // Pin on Map Button (Now triggers/refreshes the mini-map)
    const pinBtn = document.getElementById('bm-pin-btn');
    if (pinBtn) {
        pinBtn.addEventListener('click', () => {
            initMiniMap().then(() => {
                if (miniMap) {
                    miniMap.invalidateSize();
                    // Center on current site if not pinned yet
                    if (!document.getElementById('bm-lat').value) {
                         miniMap.setView([selectedSite.lat, selectedSite.lng], 13);
                         miniMapMarker.setLatLng([selectedSite.lat, selectedSite.lng]);
                         updatePinnedLocation(selectedSite.lat, selectedSite.lng);
                    }
                }
            });
            pinBtn.classList.add('hidden'); // Hide the button once map is shown
        });
    }

    // Modal Mode Switching
    document.querySelectorAll('.location-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            const modeInput = document.getElementById('bm-location-mode');
            if (modeInput) modeInput.value = mode;
            
            // UI styles
            document.querySelectorAll('.location-mode-btn').forEach(b => {
                b.style.border = '1px solid rgba(28,28,28,0.1)';
                b.style.background = 'transparent';
                b.style.color = '#64748B';
            });
            btn.style.border = '1px solid #7A8C3E';
            btn.style.background = 'rgba(122,140,62,0.06)';
            btn.style.color = '#1C1C1C';

            // Toggle containers
            const siteCont = document.getElementById('site-selector-container');
            const customCont = document.getElementById('custom-location-container');
            if (mode === 'site') {
                siteCont?.classList.remove('hidden');
                customCont?.classList.add('hidden');
            } else {
                siteCont?.classList.add('hidden');
                customCont?.classList.remove('hidden');
                // Auto-init map if custom point selected
                if (!miniMap) pinBtn?.click();
            }
        });
    });

    cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        clearConflictUI();
        cleanupBookingModal();
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
            clearConflictUI();
            cleanupBookingModal();
        }
    });

    confirmBtn.addEventListener('click', async () => {
        const modeInput = document.getElementById('bm-location-mode');
        const mode = modeInput ? modeInput.value : 'site';
        const date = dateInput.value;
        const time = document.getElementById('bm-time').value;
        const material = document.getElementById('bm-material').value;

        let bookingData = { date, time, material };

        if (mode === 'site') {
            const siteOpt = siteSelect.options[siteSelect.selectedIndex];
            const targetSite = siteOpt.value;
            const road = siteOpt.dataset.road;
            const site = DEMO_SITES.find(s => s.id === targetSite);
            
            bookingData.targetSite = site.name;
            bookingData.road = road;
        } else {
            const address = document.getElementById('bm-address').value;
            const lat = parseFloat(document.getElementById('bm-lat').value);
            const lng = parseFloat(document.getElementById('bm-lng').value);

            if (!address) { alert('Please enter delivery address'); return; }
            if (isNaN(lat)) { alert('Please pin the location on the map'); return; }

            bookingData.targetSite = '(Custom Location)';
            bookingData.customAddress = address;
            bookingData.road = 'Public Road'; // Generic road for custom points
            bookingData.customLat = lat;
            bookingData.customLng = lng;
        }

        if (!date || !time) {
            showBookingStatus('Please fill in all required fields.', 'error');
            return;
        }

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>';
        clearConflictUI();

        const result = await bookDeliverySlot(bookingData);

        confirmBtn.disabled = false;
        confirmBtn.innerHTML = 'Confirm Slot';

        if (result.success) {
            showBookingStatus(result.message, 'success');
            // Schedule will auto-update via the realtime subscription — no manual renderSchedule() needed!
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
                clearConflictUI();
                // Optionally keep miniMap or destroy? Let's keep for next time but reset inputs
                document.getElementById('bm-lat').value = '';
                document.getElementById('bm-lng').value = '';
                document.getElementById('bm-pin-status')?.classList.add('hidden');
                pinBtn?.classList.remove('hidden');
                document.getElementById('bm-mini-map')?.classList.add('hidden');
                if (miniMap) { miniMap.remove(); miniMap = null; }
            }, 1200);
        } else if (result.status === 'conflict' && result.suggestedTimeRaw) {
            // ── CONFLICT WITH SUGGESTION — render conflict prompt ────
            pendingBooking = { ...bookingData, time: result.suggestedTimeRaw };
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

/**
 * Resets the booking modal's mini-map and inputs.
 */
function cleanupBookingModal() {
    document.getElementById('bm-lat').value = '';
    document.getElementById('bm-lng').value = '';
    document.getElementById('bm-pin-status')?.classList.add('hidden');
    document.getElementById('bm-pin-btn')?.classList.remove('hidden');
    document.getElementById('bm-mini-map')?.classList.add('hidden');
    if (miniMap) {
        miniMap.remove();
        miniMap = null;
    }
}
