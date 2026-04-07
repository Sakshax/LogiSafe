/**
 * manager-view.js — Site Manager Dashboard Controller (Leaflet.js — FREE)
 *
 * Features:
 *  - Live map showing inbound truck positions (OpenStreetMap)
 *  - Slot booking with Conflict Detection
 *  - Today's schedule with status indicators
 */

import { initMaps, DARK_TILE_URL, DARK_TILE_ATTRIBUTION, DEMO_SITES, createSiteIcon, createTruckIcon } from '../config/maps-config.js';
import { bookDeliverySlot, getBookings, seedDemoBookings } from '../modules/scheduler.js';
import { to12Hour, todayISO } from '../utils/formatters.js';

let managerMap = null;
let initialized = false;

// Currently selected site
let selectedSite = DEMO_SITES[0];

export async function initManagerView() {
    if (initialized) return;
    initialized = true;

    seedDemoBookings();
    renderSchedule();
    bindBookingEvents();
    await initLiveMap();
}

export function destroyManagerView() {
    if (managerMap) {
        managerMap.remove();
        managerMap = null;
    }
    initialized = false;
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

    // Mock inbound trucks
    const mockTrucks = [
        { lat: selectedSite.lat + 0.012, lng: selectedSite.lng - 0.008, id: 'MH-04-AB-1234', driver: 'Rajesh K.', eta: '12 min' },
        { lat: selectedSite.lat - 0.008, lng: selectedSite.lng + 0.015, id: 'MH-04-CD-5678', driver: 'Sunil P.',  eta: '25 min' },
        { lat: selectedSite.lat + 0.020, lng: selectedSite.lng + 0.005, id: 'MH-04-EF-9012', driver: 'Anil M.',   eta: '38 min' },
    ];

    mockTrucks.forEach(truck => {
        const icon = createTruckIcon();
        const marker = L.marker([truck.lat, truck.lng], { icon }).addTo(managerMap);
        marker.bindPopup(`
            <div style="font-family:Inter,sans-serif;padding:6px;min-width:160px">
                <strong style="font-size:13px">${truck.id}</strong><br>
                <span style="color:#666;font-size:12px">Driver: ${truck.driver}</span><br>
                <span style="color:#059669;font-size:12px;font-weight:600">ETA: ${truck.eta}</span>
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

// ─── Schedule Rendering ─────────────────────────────────────────────────
function renderSchedule() {
    const container = document.getElementById('manager-slots-list');
    if (!container) return;

    const bookings = getBookings({ date: todayISO() });

    if (bookings.length === 0) {
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
        if (statusEl) { statusEl.classList.add('hidden'); statusEl.textContent = ''; }
    });

    cancelBtn.addEventListener('click', () => {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    });

    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.classList.add('hidden');
            modal.classList.remove('flex');
        }
    });

    confirmBtn.addEventListener('click', async () => {
        const truckId = document.getElementById('bm-truck-id').value.trim();
        const driver = document.getElementById('bm-driver').value.trim();
        const date = dateInput.value;
        const time = document.getElementById('bm-time').value;
        const siteOpt = siteSelect.options[siteSelect.selectedIndex];
        const targetSite = siteOpt.value;
        const road = siteOpt.dataset.road;

        if (!truckId || !date || !time) {
            showBookingStatus('Please fill in all required fields.', 'error');
            return;
        }

        confirmBtn.disabled = true;
        confirmBtn.innerHTML = '<span class="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>';

        const result = await bookDeliverySlot({ truckId, targetSite, road, date, time, driver });

        confirmBtn.disabled = false;
        confirmBtn.innerHTML = 'Confirm Slot';

        if (result.success) {
            showBookingStatus(result.message, 'success');
            renderSchedule();
            setTimeout(() => {
                modal.classList.add('hidden');
                modal.classList.remove('flex');
            }, 1200);
        } else {
            showBookingStatus(result.message, 'error');
        }
    });
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
