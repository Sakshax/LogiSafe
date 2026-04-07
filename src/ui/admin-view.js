/**
 * admin-view.js — Admin Dashboard Controller
 *
 * Renders heatmap of construction activity using Leaflet.js (FREE)
 * and the audit log/alert feed.
 */

import { initMaps, DARK_TILE_URL, DARK_TILE_ATTRIBUTION, MIRA_BHAYANDAR_CENTER, DEMO_SITES } from '../config/maps-config.js';
import { getBookings } from '../modules/scheduler.js';
import { timeAgo, todayISO } from '../utils/formatters.js';

let adminMap = null;
let initialized = false;

// ─── Demo audit log entries ─────────────────────────────────────────────
const DEMO_AUDIT_LOG = [
    { type: 'violation', icon: '🚨', title: 'Compliance Violation', detail: 'Truck MH-04-XX-9999 entered Site Beta without dust mitigation photo.', time: new Date(Date.now() - 600000), severity: 'critical' },
    { type: 'geofence',  icon: '📍', title: 'Geofence Triggered',   detail: 'Driver Rajesh K. arrived at Site Alpha (320m). Awaiting photo upload.', time: new Date(Date.now() - 1200000), severity: 'info' },
    { type: 'success',   icon: '✅', title: 'Delivery Completed',   detail: 'Site Alpha: 5 compliant deliveries completed today. Zero violations.', time: new Date(Date.now() - 3600000), severity: 'success' },
    { type: 'conflict',  icon: '⚠️', title: 'Slot Conflict Blocked',detail: 'Booking attempt for Kashimira Rd at 10:00 AM rejected — road at capacity.', time: new Date(Date.now() - 5400000), severity: 'warning' },
    { type: 'system',    icon: '🔄', title: 'System Update',        detail: 'Geofence radius configured to 500m for all active sites.', time: new Date(Date.now() - 7200000), severity: 'info' },
    { type: 'success',   icon: '✅', title: 'Photo Verified',       detail: 'Site Gamma: Dust mitigation photo verified. Green netting confirmed.', time: new Date(Date.now() - 9000000), severity: 'success' },
];

export async function initAdminView() {
    if (initialized) return;
    initialized = true;

    renderStats();
    renderAuditLog();
    await initHeatmap();
}

export function destroyAdminView() {
    if (adminMap) {
        adminMap.remove();
        adminMap = null;
    }
    initialized = false;
}

// ─── Stats Cards ────────────────────────────────────────────────────────
function renderStats() {
    const bookings = getBookings({ date: todayISO() });
    const statsContainer = document.getElementById('admin-stats');
    if (!statsContainer) return;

    const stats = [
        { label: 'Active Sites', value: DEMO_SITES.length, icon: '🏗️', color: 'from-blue-500/20 to-blue-600/5', text: 'text-blue-400' },
        { label: "Today's Deliveries", value: bookings.length, icon: '🚛', color: 'from-emerald-500/20 to-emerald-600/5', text: 'text-emerald-400' },
        { label: 'Compliance Rate', value: '94%', icon: '✅', color: 'from-amber-500/20 to-amber-600/5', text: 'text-amber-400' },
        { label: 'Violations Today', value: 1, icon: '🚨', color: 'from-red-500/20 to-red-600/5', text: 'text-red-400' },
    ];

    statsContainer.innerHTML = stats.map(s => `
        <div class="stat-card bg-slate-800/60 border border-white/5 rounded-2xl p-5 backdrop-blur-sm hover:border-white/10 transition-all duration-300">
            <div class="flex items-center justify-between mb-3">
                <span class="text-2xl">${s.icon}</span>
                <div class="w-10 h-10 rounded-xl bg-gradient-to-br ${s.color} flex items-center justify-center">
                    <span class="${s.text} text-lg font-bold">${typeof s.value === 'number' ? s.value : ''}</span>
                </div>
            </div>
            <p class="text-2xl font-bold text-white">${s.value}</p>
            <p class="text-sm text-slate-400 mt-1">${s.label}</p>
        </div>
    `).join('');
}

// ─── Audit Log ──────────────────────────────────────────────────────────
function renderAuditLog() {
    const container = document.getElementById('admin-audit-logs');
    if (!container) return;

    const severityStyles = {
        critical: 'border-l-red-500 bg-red-500/5',
        warning:  'border-l-amber-500 bg-amber-500/5',
        success:  'border-l-emerald-500 bg-emerald-500/5',
        info:     'border-l-blue-500 bg-blue-500/5',
    };

    const severityTextStyles = {
        critical: 'text-red-400',
        warning:  'text-amber-400',
        success:  'text-emerald-400',
        info:     'text-blue-400',
    };

    container.innerHTML = DEMO_AUDIT_LOG.map((log, i) => `
        <div class="audit-log-item border-l-4 ${severityStyles[log.severity]} rounded-r-xl p-4 transition-all duration-300 hover:translate-x-1" style="animation-delay: ${i * 80}ms">
            <div class="flex items-start gap-3">
                <span class="text-lg mt-0.5 flex-shrink-0">${log.icon}</span>
                <div class="flex-1 min-w-0">
                    <p class="font-semibold ${severityTextStyles[log.severity]} text-sm">${log.title}</p>
                    <p class="text-slate-300 text-sm mt-1 leading-relaxed">${log.detail}</p>
                    <p class="text-slate-500 text-xs mt-2">${timeAgo(log.time)}</p>
                </div>
            </div>
        </div>
    `).join('');
}

// ─── Heatmap (Leaflet.js — FREE) ────────────────────────────────────────
async function initHeatmap() {
    const mapContainer = document.getElementById('admin-map');
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

    // Create Leaflet map with dark tiles
    adminMap = L.map(mapContainer, {
        center: [MIRA_BHAYANDAR_CENTER.lat, MIRA_BHAYANDAR_CENTER.lng],
        zoom: 13,
        zoomControl: true,
        attributionControl: false
    });

    L.tileLayer(DARK_TILE_URL, {
        attribution: DARK_TILE_ATTRIBUTION,
        maxZoom: 19
    }).addTo(adminMap);

    // Heatmap Data — weighted points around construction sites
    const heatData = [];
    DEMO_SITES.forEach(site => {
        for (let i = 0; i < 10; i++) {
            heatData.push([
                site.lat + (Math.random() - 0.5) * 0.008,
                site.lng + (Math.random() - 0.5) * 0.008,
                Math.random() * 0.8 + 0.3 // intensity
            ]);
        }
    });

    // Add heatmap layer if plugin loaded
    if (window.L && L.heatLayer) {
        L.heatLayer(heatData, {
            radius: 30,
            blur: 20,
            maxZoom: 17,
            gradient: { 0.2: '#2563eb', 0.4: '#7c3aed', 0.6: '#f59e0b', 0.8: '#ef4444', 1.0: '#dc2626' }
        }).addTo(adminMap);
    }

    // Site Markers
    DEMO_SITES.forEach(site => {
        const marker = L.marker([site.lat, site.lng], {
            icon: L.divIcon({
                className: '',
                html: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(59,130,246,0.6)"></div>`,
                iconSize: [16, 16],
                iconAnchor: [8, 8]
            })
        }).addTo(adminMap);

        marker.bindPopup(`
            <div style="font-family:Inter,sans-serif;padding:4px">
                <strong style="font-size:13px">${site.name}</strong><br>
                <span style="color:#666;font-size:12px">Road: ${site.road}</span><br>
                <span style="color:#059669;font-size:12px;font-weight:600">Status: Active</span>
            </div>
        `);
    });

    // Fix map sizing after panel renders
    setTimeout(() => adminMap.invalidateSize(), 200);
}
