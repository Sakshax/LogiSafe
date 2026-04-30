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

import { initMaps, DARK_TILE_URL, DARK_TILE_ATTRIBUTION, DEMO_SITES, createSiteIcon, createTruckIcon, STANDARD_TILE_URL, STANDARD_TILE_ATTRIBUTION, addRoadRoute } from '../config/maps-config.js';
import {
    bookDeliverySlot,
    subscribeToBookings,
    generateAllSlots,
    getOccupiedTimes,
    findNextAvailableSlot,
    checkConflict,
} from '../modules/scheduler.js';
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
let unsubscribeAlerts = null;

// Realtime subscription used while the booking modal is open. Keyed by
// the date currently selected inside the modal so we can swap when the
// user changes the date picker.
let unsubscribeBookingModalDate = null;
let modalSubscribedDate = null;

// Map marker dictionary for live trucks { truckId: L.marker }
let truckMarkers = {};
let truckPaths = {}; // Store routing polylines/controls
let truckDestCircles = {}; // Dynamic geofence circles per truck destination

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
    if (unsubscribeAlerts) {
        unsubscribeAlerts();
        unsubscribeAlerts = null;
    }
    if (unsubscribeBookingModalDate) {
        unsubscribeBookingModalDate();
        unsubscribeBookingModalDate = null;
        modalSubscribedDate = null;
    }

    // Clean up map
    if (managerMap) {
        managerMap.remove();
        managerMap = null;
    }

    truckMarkers = {};
    truckPaths = {};
    truckDestCircles = {};
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
        'PENDING_ADMIN': { text: 'text-[#E05535]', dot: 'bg-[#E05535]', label: 'Pending' },
        'SCHEDULED': { text: 'text-[#7A8C3E]', dot: 'bg-[#7A8C3E]', label: 'Scheduled' },
        'EN_ROUTE':  { text: 'text-[#F4A623]', dot: 'bg-[#F4A623]', label: 'En Route' },
        'ARRIVED':   { text: 'text-[#1C1C1C]', dot: 'bg-[#1C1C1C]', label: 'Arrived' },
        'COMPLETED': { text: 'text-[#64748B]', dot: 'bg-[#64748B]', label: 'Completed' },
    };

    container.innerHTML = bookings.map((b, i) => {
        const sc = statusConfig[b.status] || statusConfig['SCHEDULED'];
        const timeStr = to12Hour(b.time);
        const isCustom = b.targetSite === '(Custom Location)' || !!b.customAddress;
        const destDisplay = b.destName || b.customAddress || b.targetSite || 'Unknown';
        return `
        <div class="flex items-center gap-6 p-4 border border-[#1C1C1C]/10 bg-white transition-all duration-300" style="animation-delay: ${i * 60}ms">
            <div class="w-16 text-center border-r border-[#1C1C1C]/10 pr-6">
                <p class="text-[10px] font-extrabold text-[#1C1C1C]">${timeStr.split(' ')[0]}</p>
                <p class="text-[9px] font-bold text-[#64748B] uppercase">${timeStr.split(' ')[1]}</p>
            </div>
            <div class="flex-1 min-w-0">
                <p class="ui-label text-[#7A8C3E] mb-1">/ ${isCustom ? '📌 Custom Delivery' : 'Tracking Active'}</p>
                <p class="font-bold text-[#1C1C1C] text-sm uppercase tracking-tight">${b.truckId || 'Pending Assignment'}</p>
                <p class="text-[10px] text-[#64748B] font-medium mt-1 uppercase tracking-wider">${b.driver || 'No Driver'} · ${destDisplay}</p>
                <div class="mt-2 flex flex-wrap gap-1">
                    ${b.material ? `<span class="px-2 py-0.5 bg-[#F8FAFC] text-[#1C1C1C] text-[9px] font-extrabold uppercase tracking-widest border border-[#1C1C1C]/10">${b.material}</span>` : ''}
                    ${isCustom ? `<span class="px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-widest border" style="background:rgba(224,85,53,0.06);color:#E05535;border-color:rgba(224,85,53,0.15);">📌 Custom Point</span>` : ''}
                </div>
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
    import('../config/firebase-config.js').then(({ db, collection, onSnapshot }) => {
        let isInitialLoad = true;
        unsubscribeAlerts = onSnapshot(collection(db, 'live_alerts'), (snapshot) => {
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
 * - Moves markers for existing trucks to their REAL GPS position
 * - Removes markers for trucks that went offline
 * - Draws a simple dashed line from truck position to destination
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
                <div style="color:#94a3b8;font-size:10px;margin-bottom:4px">
                    📍 ${truck.lat.toFixed(4)}, ${truck.lng.toFixed(4)}
                </div>
                <div style="display:flex;align-items:center;justify-content:between;border-top:1px solid #eee;padding-top:4px;margin-top:4px">
                    <span style="color:#059669;font-size:11px;font-weight:600">LIVE TRACKING</span>
                    <span style="color:#94a3b8;font-size:10px;margin-left:auto">${timeStr}</span>
                </div>
            </div>
        `;

        // Update existing marker or create new one
        if (truckMarkers[truck.id]) {
            // Smoothly move marker to new real GPS position
            truckMarkers[truck.id].setLatLng([truck.lat, truck.lng]);
            truckMarkers[truck.id].setPopupContent(popupContent);
        } else {
            const icon = createTruckIcon();
            const marker = L.marker([truck.lat, truck.lng], { icon }).addTo(managerMap);
            marker.bindPopup(popupContent);
            truckMarkers[truck.id] = marker;
        }

        // Draw/Update road-following route from truck to destination
        if (truck.destLat && truck.destLng) {
            // Remove old route
            if (truckPaths[truck.id]) {
                try { truckPaths[truck.id].remove(); } catch(e) {}
                try { managerMap.removeLayer(truckPaths[truck.id]); } catch(e) {}
                delete truckPaths[truck.id];
            }
            
            // Draw road-following route via OSRM (falls back to straight line)
            truckPaths[truck.id] = addRoadRoute(
                managerMap,
                [truck.lat, truck.lng],
                [truck.destLat, truck.destLng],
                { color: '#7A8C3E', weight: 4, opacity: 0.6 }
            );

            // Draw dynamic geofence circle around destination (if not already drawn for this dest)
            const destKey = `${truck.destLat.toFixed(4)}_${truck.destLng.toFixed(4)}`;
            if (!truckDestCircles[destKey]) {
                truckDestCircles[destKey] = L.circle([truck.destLat, truck.destLng], {
                    radius: 500,
                    color: '#7A8C3E',
                    fillColor: '#7A8C3E',
                    fillOpacity: 0.08,
                    weight: 1,
                    dashArray: '6, 4'
                }).addTo(managerMap);
            }

            // Dynamic destination marker for custom points (standard sites already have markers from initLiveMap)
            const isStandardSite = DEMO_SITES.some(s => Math.abs(s.lat - truck.destLat) < 0.001 && Math.abs(s.lng - truck.destLng) < 0.001);
            const destMarkerKey = `dest_${destKey}`;
            if (!isStandardSite && !truckMarkers[destMarkerKey]) {
                const destIcon = L.divIcon({
                    className: 'dest-pin-custom',
                    html: `<div style="width:22px;height:22px;background:#E05535;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(224,85,53,0.4);display:flex;align-items:center;justify-content:center;">
                             <div style="width:5px;height:5px;background:#fff;border-radius:50%;"></div>
                           </div>`,
                    iconSize: [22, 22],
                    iconAnchor: [11, 11]
                });
                truckMarkers[destMarkerKey] = L.marker([truck.destLat, truck.destLng], { icon: destIcon })
                    .addTo(managerMap)
                    .bindPopup(`<div style="font-family:Inter,sans-serif;padding:4px;"><strong style="font-size:12px;">📌 Custom Destination</strong><br><span style="color:#E05535;font-size:11px;font-weight:600;">Driver: ${truck.driver || 'Unknown'}</span></div>`);
            }
        }
    });

    // Cleanup markers, paths, and circles for trucks that went offline
    for (const id of Object.keys(truckMarkers)) {
        if (!currentIds.has(id) && !id.startsWith('dest_')) {
            managerMap.removeLayer(truckMarkers[id]);
            delete truckMarkers[id];
            
            if (truckPaths[id]) {
                try { truckPaths[id].remove(); } catch(e) {}
                try { managerMap.removeLayer(truckPaths[id]); } catch(e) {}
                delete truckPaths[id];
            }
        }
    }

    // Clean up geofence circles and destination markers that no longer have any active truck headed to them
    const activeDestKeys = new Set();
    trucks.forEach(t => {
        if (t.destLat && t.destLng) {
            activeDestKeys.add(`${t.destLat.toFixed(4)}_${t.destLng.toFixed(4)}`);
        }
    });
    for (const key of Object.keys(truckDestCircles)) {
        if (!activeDestKeys.has(key)) {
            try { managerMap.removeLayer(truckDestCircles[key]); } catch(e) {}
            delete truckDestCircles[key];
        }
    }
    for (const key of Object.keys(truckMarkers)) {
        if (key.startsWith('dest_')) {
            const coordKey = key.replace('dest_', '');
            if (!activeDestKeys.has(coordKey)) {
                try { managerMap.removeLayer(truckMarkers[key]); } catch(e) {}
                delete truckMarkers[key];
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

    // Geofence circles are drawn dynamically when active trucks appear
    // (see reconcileTruckMarkers) — no hardcoded circle here.

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

// ════════════════════════════════════════════════════════════════════════
//  BOOKING MODAL — REAL-TIME CONFLICT DETECTION
//  Subscribes to bookings for the chosen date the moment the modal opens
//  and re-renders the time selector + conflict pill on every keystroke,
//  every Firestore snapshot, and every site/date change.
// ════════════════════════════════════════════════════════════════════════

function bindBookingEvents() {
    const modal     = document.getElementById('booking-modal');
    const openBtn   = document.getElementById('new-booking-btn');
    const cancelBtn = document.getElementById('bm-cancel');
    const confirmBtn = document.getElementById('bm-confirm');
    const dateInput = document.getElementById('bm-date');
    const timeInput = document.getElementById('bm-time');
    const siteSelect = document.getElementById('bm-site');
    if (!openBtn) return;

    if (dateInput) dateInput.value = todayISO();

    if (siteSelect) {
        siteSelect.innerHTML = DEMO_SITES.map(s =>
            `<option value="${s.id}" data-road="${s.road}">${s.name}</option>`
        ).join('');
    }

    // ── Open modal: hydrate + start realtime conflict tracking ──────
    openBtn.addEventListener('click', () => {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        clearConflictUI();
        rebuildTimeSelector();
        startBookingModalSubscription();
        refreshConflictPill();
    });

    // ── Re-render conflict UI whenever ANY booking input changes ────
    const reactiveInputs = ['bm-date', 'bm-time', 'bm-site', 'bm-location-mode'];
    reactiveInputs.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        const handler = () => {
            if (id === 'bm-date') startBookingModalSubscription();
            // Don't rebuild the <select> while the user is inside it —
            // that would cause flicker. Time changes only affect the pill.
            if (id !== 'bm-time') rebuildTimeSelector();
            refreshConflictPill();
        };
        el.addEventListener('change', handler);
        el.addEventListener('input', handler);
    });

    // ── Pin-on-map button ───────────────────────────────────────────
    const pinBtn = document.getElementById('bm-pin-btn');
    if (pinBtn) {
        pinBtn.addEventListener('click', () => {
            initMiniMap().then(() => {
                if (miniMap) {
                    miniMap.invalidateSize();
                    if (!document.getElementById('bm-lat').value) {
                         miniMap.setView([selectedSite.lat, selectedSite.lng], 13);
                         miniMapMarker.setLatLng([selectedSite.lat, selectedSite.lng]);
                         updatePinnedLocation(selectedSite.lat, selectedSite.lng);
                    }
                }
            });
            pinBtn.classList.add('hidden');
        });
    }

    // ── Location-mode toggle (Standard Site ↔ Custom Point) ─────────
    document.querySelectorAll('.location-mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const mode = btn.dataset.mode;
            const modeInput = document.getElementById('bm-location-mode');
            if (modeInput) modeInput.value = mode;

            document.querySelectorAll('.location-mode-btn').forEach(b => {
                b.style.border = '1px solid rgba(28,28,28,0.1)';
                b.style.background = 'transparent';
                b.style.color = '#64748B';
                b.classList.remove('is-selected');
            });
            btn.style.border = '1px solid #7A8C3E';
            btn.style.background = 'rgba(122,140,62,0.08)';
            btn.style.color = '#1C1C1C';
            btn.classList.add('is-selected');

            const siteCont = document.getElementById('site-selector-container');
            const customCont = document.getElementById('custom-location-container');
            if (mode === 'site') {
                siteCont?.classList.remove('hidden');
                customCont?.classList.add('hidden');
            } else {
                siteCont?.classList.add('hidden');
                customCont?.classList.remove('hidden');
                if (!miniMap) pinBtn?.click();
            }
            // Road just changed → re-evaluate conflicts immediately.
            rebuildTimeSelector();
            refreshConflictPill();
        });
    });

    const closeModal = () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
        clearConflictUI();
        cleanupBookingModal();
        stopBookingModalSubscription();
    };
    cancelBtn.addEventListener('click', closeModal);
    document.getElementById('bm-cancel-2')?.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

    // ── Confirm: with realtime detection this should rarely conflict
    //    (the user already saw the green pill), but keep server-side
    //    double-check via the engine. ────────────────────────────────
    confirmBtn.addEventListener('click', async () => {
        const bookingData = collectBookingFormData();
        if (!bookingData) return;

        const { date, time } = bookingData;
        if (!date || !time) {
            showBookingStatus('Please fill in date and time.', 'error');
            return;
        }

        confirmBtn.disabled = true;
        confirmBtn.classList.add('is-loading');
        confirmBtn.innerHTML = '<span class="btn-spinner"></span><span>Booking…</span>';

        const result = await bookDeliverySlot(bookingData);

        confirmBtn.disabled = false;
        confirmBtn.classList.remove('is-loading');
        confirmBtn.innerHTML = 'Confirm Slot Request';

        if (result.success) {
            showBookingStatus(result.message, 'success');
            setTimeout(() => {
                closeModal();
                document.getElementById('bm-lat').value = '';
                document.getElementById('bm-lng').value = '';
                document.getElementById('bm-pin-status')?.classList.add('hidden');
                pinBtn?.classList.remove('hidden');
                document.getElementById('bm-mini-map')?.classList.add('hidden');
                if (miniMap) { miniMap.remove(); miniMap = null; }
            }, 1100);
        } else if (result.status === 'conflict' && result.suggestedTimeRaw) {
            // Race condition: someone else booked it between user's last
            // glance at the green pill and the Confirm click. Show suggestion.
            pendingBooking = { ...bookingData, time: result.suggestedTimeRaw };
            renderConflictSuggestion(result);
            // Also reflect in the live pill
            refreshConflictPill();
        } else if (result.status === 'full') {
            showBookingStatus(result.message, 'error');
        } else {
            showBookingStatus(result.message, 'error');
        }
    });
}


// ─── Form-data collector (used by Confirm + by the live pill) ──────────
function collectBookingFormData() {
    const dateInput  = document.getElementById('bm-date');
    const timeInput  = document.getElementById('bm-time');
    const siteSelect = document.getElementById('bm-site');
    const modeInput  = document.getElementById('bm-location-mode');
    const material   = document.getElementById('bm-material')?.value || '';

    if (!dateInput || !timeInput || !siteSelect) return null;

    const mode = modeInput ? modeInput.value : 'site';
    const date = dateInput.value;
    const time = timeInput.value;

    const data = { date, time, material };

    if (mode === 'site') {
        const siteOpt = siteSelect.options[siteSelect.selectedIndex];
        if (!siteOpt) return null;
        const site = DEMO_SITES.find(s => s.id === siteOpt.value);
        if (!site) return null;
        data.targetSite  = site.name;
        data.road        = siteOpt.dataset.road;
        data.destLat     = site.lat;
        data.destLng     = site.lng;
        data.destName    = site.name;
    } else {
        const address = document.getElementById('bm-address').value;
        const lat = parseFloat(document.getElementById('bm-lat').value);
        const lng = parseFloat(document.getElementById('bm-lng').value);

        if (!address) { alert('Please enter delivery address'); return null; }
        if (isNaN(lat)) { alert('Please pin the location on the map'); return null; }

        // Use location-specific road name so nearby custom bookings conflict
        // but distant ones don't share a slot
        const roadName = `Custom · ${lat.toFixed(2)},${lng.toFixed(2)}`;

        data.targetSite     = '(Custom Location)';
        data.customAddress  = address;
        data.road           = roadName;
        data.customLat      = lat;
        data.customLng      = lng;
        data.destLat        = lat;
        data.destLng        = lng;
        data.destName       = address;
    }
    return data;
}


// ─── Realtime subscription tied to the modal's date input ──────────────
function startBookingModalSubscription() {
    const date = document.getElementById('bm-date')?.value || todayISO();
    if (modalSubscribedDate === date && unsubscribeBookingModalDate) return;

    if (unsubscribeBookingModalDate) {
        unsubscribeBookingModalDate();
        unsubscribeBookingModalDate = null;
    }

    modalSubscribedDate = date;
    unsubscribeBookingModalDate = subscribeToBookings(date, () => {
        // The scheduler module's localBookings cache is now fresh; recompute UI.
        rebuildTimeSelector();
        refreshConflictPill();
    });
}

function stopBookingModalSubscription() {
    if (unsubscribeBookingModalDate) {
        unsubscribeBookingModalDate();
        unsubscribeBookingModalDate = null;
        modalSubscribedDate = null;
    }
}


// ─── Time selector: re-render with live occupancy markers ──────────────
function rebuildTimeSelector() {
    const timeInput = document.getElementById('bm-time');
    if (!timeInput) return;

    const data = collectBookingFormData();
    const road = data?.road;
    const date = data?.date || todayISO();
    const occupied = road ? getOccupiedTimes(road, date) : new Map();

    const previousValue = timeInput.value;
    const allSlots = generateAllSlots();

    timeInput.innerHTML = allSlots.map(slot => {
        const taken = occupied.has(slot);
        const label = `${to12Hour(slot)}${taken ? ' • 🚫 Taken' : ''}`;
        return `<option value="${slot}"${taken ? ' disabled data-taken="1"' : ''}>${label}</option>`;
    }).join('');

    // Preserve the user's selection if still valid; else pick the first
    // free slot — this gives instant useful feedback.
    if (previousValue && allSlots.includes(previousValue) && !occupied.has(previousValue)) {
        timeInput.value = previousValue;
    } else {
        const firstFree = allSlots.find(s => !occupied.has(s));
        timeInput.value = firstFree || allSlots[0];
    }
}


// ─── Live Conflict Pill — renders under the time selector ──────────────
function refreshConflictPill() {
    const pill = document.getElementById('bm-conflict-live');
    if (!pill) return;

    const data = collectBookingFormData();
    if (!data || !data.road || !data.date || !data.time) {
        pill.className = 'conflict-live conflict-live--idle';
        pill.innerHTML = `
            <span class="conflict-live__icon">⏳</span>
            <span class="conflict-live__text">Pick a road, date, and time to check capacity…</span>
        `;
        return;
    }

    const { road, date, time } = data;

    // Fast-fail if the slot is in the past
    const isToday = date === todayISO();
    let isPast = false;
    if (date < todayISO()) {
        isPast = true;
    } else if (isToday) {
        const now = new Date();
        const [slotHour, slotMin] = time.split(':').map(Number);
        if (slotHour < now.getHours() || (slotHour === now.getHours() && slotMin < now.getMinutes())) {
            isPast = true;
        }
    }

    if (isPast) {
        pill.className = 'conflict-live conflict-live--conflict';
        pill.innerHTML = `
            <span class="conflict-live__icon">⚠️</span>
            <span class="conflict-live__text">
                <strong>Slot unavailable</strong> at ${to12Hour(time)}.
                <span class="conflict-live__sub">This time slot has already passed today.</span>
            </span>
        `;
        return;
    }

    const { conflict, booking } = checkConflict(road, date, time);

    if (!conflict) {
        const occupied = getOccupiedTimes(road, date);
        const totalSlots = generateAllSlots().length;
        const freeCount  = totalSlots - occupied.size;
        pill.className = 'conflict-live conflict-live--ok';
        pill.innerHTML = `
            <span class="conflict-live__icon">✓</span>
            <span class="conflict-live__text">
                <strong>Slot available</strong> on ${escapeHTML(road)} at ${to12Hour(time)}.
                <span class="conflict-live__sub">${freeCount} of ${totalSlots} 30-min windows free today on this road.</span>
            </span>
            <span class="conflict-live__live"><span class="conflict-live__dot"></span>Live</span>
        `;
        return;
    }

    // Conflict — find next available + offer one-click swap.
    const next = findNextAvailableSlot(road, date, time);
    const nextHtml = next.found
        ? `<button type="button" class="conflict-live__swap" id="bm-swap-time" data-time="${next.time}">
               Use ${escapeHTML(next.display)} →
           </button>`
        : `<span class="conflict-live__sub">No free slot on this road today.</span>`;

    pill.className = 'conflict-live conflict-live--conflict';
    pill.innerHTML = `
        <span class="conflict-live__icon">⚠</span>
        <span class="conflict-live__text">
            <strong>Conflict at ${to12Hour(time)}</strong> — ${escapeHTML(booking.driver || booking.truckId || 'Another truck')} is on ${escapeHTML(road)}.
            <span class="conflict-live__sub">Narrow road allows only 1 truck per 30-min window.</span>
        </span>
        ${nextHtml}
    `;

    // Wire the one-click swap-to-next-free-slot button.
    const swapBtn = document.getElementById('bm-swap-time');
    if (swapBtn) {
        swapBtn.addEventListener('click', () => {
            const t = swapBtn.dataset.time;
            const timeInput = document.getElementById('bm-time');
            if (t && timeInput) {
                timeInput.value = t;
                refreshConflictPill();
            }
        });
    }
}


// ─── Conflict-suggestion fallback (race-condition path on Confirm) ─────
function renderConflictSuggestion(result) {
    const statusEl = document.getElementById('bm-status');
    if (!statusEl) return;

    statusEl.classList.remove('hidden');
    statusEl.className = 'conflict-suggestion';
    statusEl.innerHTML = `
        <div class="conflict-suggestion__head">
            <span class="conflict-suggestion__head-icon">🚫</span>
            <div class="conflict-suggestion__head-text">
                <p class="conflict-suggestion__title">Conflict detected at booking time</p>
                <p class="conflict-suggestion__sub">${escapeHTML(result.message)}</p>
            </div>
        </div>
        <div class="conflict-suggestion__body">
            <div class="conflict-suggestion__next">
                <span class="conflict-suggestion__next-label">Next available</span>
                <span class="conflict-suggestion__next-time">${escapeHTML(result.suggestedTime)}</span>
            </div>
            <div class="conflict-suggestion__actions">
                <button type="button" id="bm-accept-suggestion" class="btn-primary conflict-suggestion__accept">
                    Accept ${escapeHTML(result.suggestedTime)}
                </button>
                <button type="button" id="bm-reject-suggestion" class="conflict-suggestion__reject">
                    Cancel
                </button>
            </div>
        </div>
    `;

    document.getElementById('bm-accept-suggestion')?.addEventListener('click', async () => {
        if (!pendingBooking) return;
        const acceptBtn = document.getElementById('bm-accept-suggestion');
        acceptBtn.disabled = true;
        acceptBtn.classList.add('is-loading');
        acceptBtn.innerHTML = '<span class="btn-spinner"></span><span>Booking…</span>';

        const r = await bookDeliverySlot(pendingBooking);
        if (r.success) {
            statusEl.className = 'status-msg status-success';
            statusEl.textContent = r.message;
            pendingBooking = null;
            setTimeout(() => {
                document.getElementById('booking-modal')?.classList.add('hidden');
                clearConflictUI();
            }, 1300);
        } else {
            showBookingStatus(`Suggested slot also taken: ${r.message}`, 'error');
            pendingBooking = null;
            refreshConflictPill();
        }
    });
    document.getElementById('bm-reject-suggestion')?.addEventListener('click', () => {
        clearConflictUI();
        pendingBooking = null;
    });
}

function clearConflictUI() {
    const statusEl = document.getElementById('bm-status');
    if (statusEl) {
        statusEl.classList.add('hidden');
        statusEl.className = 'hidden';
        statusEl.innerHTML = '';
    }
    pendingBooking = null;
}

function showBookingStatus(message, type) {
    const el = document.getElementById('bm-status');
    if (!el) return;
    el.classList.remove('hidden');
    el.className = `status-msg status-${type === 'success' ? 'success' : 'error'}`;
    el.textContent = message;
}

// ─── Tiny HTML escape helper used by the realtime panels ───────────────
function escapeHTML(s) {
    return String(s ?? '').replace(/[&<>"']/g, ch => ({
        '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
    }[ch]));
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
