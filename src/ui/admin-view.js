/**
 * admin-view.js — Full Admin Portal Controller v4
 *
 * Tabbed interface:
 *  TAB 1: Dashboard — Heatmap + Pending Approvals + Audit Log
 *  TAB 2: Users — All Drivers (approve/reject/suspend) + All Managers
 *  TAB 3: Bookings — All logistics slots from Firestore with cancel
 *  TAB 4: Live Alerts + Compliance Records from Firestore
 */

import { initMaps, DARK_TILE_URL, DARK_TILE_ATTRIBUTION, MIRA_BHAYANDAR_CENTER, DEMO_SITES, STANDARD_TILE_URL, STANDARD_TILE_ATTRIBUTION, addRoadRoute, createDriverIcon } from '../config/maps-config.js';
import { getBookings, cancelBooking, assignDriverAndSendLink } from '../modules/scheduler.js';
import {
    getPendingDrivers, approveDriver, rejectDriver,
    getAllDrivers, getAllManagers, updateUserStatus,
    getDriversWithLocations, subscribeToPendingDrivers, subscribeToAllDrivers
} from '../modules/auth.js';
import { listenToActiveTrucks } from '../modules/tracking.js';
import { createTruckIcon } from '../config/maps-config.js';
import { calculateDistance } from '../utils/haversine.js';
import {
    db, collection, getDocs, query, where, orderBy, onSnapshot, deleteDoc, doc
} from '../config/firebase-config.js';
import { timeAgo, todayISO, to12Hour } from '../utils/formatters.js';

let adminMap = null;
let initialized = false;
let unsubscribeListeners = [];
let truckMarkers = {}; // Realtime truck markers
let truckPaths = {}; // Store routing polylines

// ─── Audit Log State ────────────────────────────────────────────────────
const flaggedLogs = new Set();

const DEMO_AUDIT_LOG = [
    { id: 'log-1', type: 'violation', icon: '🚨', title: 'Compliance Violation', detail: 'Truck MH-04-XX-9999 entered Site Beta without dust mitigation photo.', time: new Date(Date.now() - 600000), severity: 'critical' },
    { id: 'log-2', type: 'geofence',  icon: '📍', title: 'Geofence Triggered',   detail: 'Driver Rajesh K. arrived at Site Alpha (320m). Awaiting photo upload.', time: new Date(Date.now() - 1200000), severity: 'info' },
    { id: 'log-3', type: 'success',   icon: '✅', title: 'Delivery Completed',   detail: 'Site Alpha: 5 compliant deliveries completed today. Zero violations.', time: new Date(Date.now() - 3600000), severity: 'success' },
    { id: 'log-4', type: 'conflict',  icon: '⚠️', title: 'Slot Conflict Blocked',detail: 'Booking attempt for Kashimira Rd at 10:00 AM rejected — road at capacity.', time: new Date(Date.now() - 5400000), severity: 'warning' },
    { id: 'log-5', type: 'violation', icon: '🚨', title: 'Speeding Violation',    detail: 'Truck MH-04-QQ-7777 exceeded 30 km/h limit near Site Gamma school zone.', time: new Date(Date.now() - 6600000), severity: 'critical' },
    { id: 'log-6', type: 'system',    icon: '🔄', title: 'System Update',        detail: 'Geofence radius configured to 500m for all active sites.', time: new Date(Date.now() - 7200000), severity: 'info' },
    { id: 'log-7', type: 'success',   icon: '✅', title: 'Photo Verified',       detail: 'Site Gamma: Dust mitigation photo verified. Green netting confirmed.', time: new Date(Date.now() - 9000000), severity: 'success' },
];

// ─── Init / Destroy ─────────────────────────────────────────────────────

export async function initAdminView() {
    if (initialized) return;
    initialized = true;

    renderStats();
    renderAuditLog();
    bindAdminTabs();
    bindRefreshButtons();
    await loadPendingDrivers();
    await initHeatmap();
    startRealtimeStats();
}

export function destroyAdminView() {
    if (adminMap) { adminMap.remove(); adminMap = null; }
    unsubscribeListeners.forEach(fn => fn());
    unsubscribeListeners = [];
    truckMarkers = {};
    truckPaths = {};
    initialized = false;
}

// ─── Tab Navigation ─────────────────────────────────────────────────────

function bindAdminTabs() {
    const tabs = document.querySelectorAll('.admin-tab');
    tabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            switchAdminTab(target);

            // Load data when switching to a tab
            if (target === 'users') { loadAllDrivers(); loadAllManagers(); }
            if (target === 'bookings') { loadAllBookings(); }
            if (target === 'alerts') { loadLiveAlerts(); loadComplianceRecords(); }
        });
    });
}

function switchAdminTab(tab) {
    // Update tab buttons
    document.querySelectorAll('.admin-tab').forEach(t => {
        t.classList.remove('active', 'border-b-2', 'border-[#7A8C3E]', 'text-[#1C1C1C]');
        t.classList.add('text-[#64748B]');
    });
    const activeTab = document.querySelector(`.admin-tab[data-tab="${tab}"]`);
    if (activeTab) {
        activeTab.classList.add('active', 'border-b-2', 'border-[#7A8C3E]', 'text-[#1C1C1C]');
        activeTab.classList.remove('text-[#64748B]');
    }

    // Show/hide content
    document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.add('hidden'));
    const content = document.getElementById(`admin-tab-${tab}`);
    if (content) content.classList.remove('hidden');
}

// ─── Refresh Buttons ────────────────────────────────────────────────────

function bindRefreshButtons() {
    const bindings = {
        'refresh-pending-btn': loadPendingDrivers,
        'refresh-drivers-btn': loadAllDrivers,
        'refresh-managers-btn': loadAllManagers,
        'refresh-bookings-btn': loadAllBookings,
        'refresh-compliance-btn': loadComplianceRecords,
    };
    Object.entries(bindings).forEach(([id, fn]) => {
        const btn = document.getElementById(id);
        if (btn) btn.addEventListener('click', fn);
    });
}

// ─── Stats Cards ────────────────────────────────────────────────────────

function renderStats() {
    const bookings = getBookings({ date: todayISO() });
    const el = document.getElementById('admin-stats');
    if (!el) return;

    const violationCount = DEMO_AUDIT_LOG.filter(l => l.severity === 'critical').length;

    const stats = [
        { label: 'Active Sites', value: DEMO_SITES.length, icon: '🏗️', color: 'bg-[#F8FAFC]' },
        { label: "Today's Deliveries", value: bookings.length, icon: '🚛', color: 'bg-[#F8FAFC]' },
        { label: 'Compliance Rate', value: '94%', icon: '✅', color: 'bg-[#F8FAFC]' },
        { label: 'Violations Today', value: violationCount, icon: '🚨', color: 'bg-[#E05535]/10' },
    ];

    el.innerHTML = stats.map(s => `
        <div class="dash-card p-6 flex flex-col justify-between">
            <div class="flex items-center justify-between mb-4">
                <span class="text-xl">${s.icon}</span>
                <span class="ui-label text-[#64748B]">/ Global</span>
            </div>
            <div>
                <p class="text-4xl font-extrabold text-[#1C1C1C]">${s.value}</p>
                <p class="ui-label mt-2 text-[#7A8C3E]">${s.label}</p>
            </div>
        </div>
    `).join('');
}

/**
 * Subscribe to Firestore bookings for today to get live stats.
 * Updates the admin dashboard stats cards with real data.
 */
function startRealtimeStats() {
    const today = todayISO();
    try {
        const q = query(
            collection(db, 'logistics_slots'),
            where('date', '==', today)
        );
        const unsub = onSnapshot(q, async (snapshot) => {
            const bookings = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            const completedCount = bookings.filter(b => b.status === 'COMPLETED').length;

            // Calculate compliance rate from actual data
            let complianceRate = '—';
            if (bookings.length > 0) {
                const rate = Math.round((completedCount / bookings.length) * 100);
                complianceRate = `${rate}%`;
            }

            const violationCount = DEMO_AUDIT_LOG.filter(l => l.severity === 'critical').length;

            const el = document.getElementById('admin-stats');
            if (!el) return;

            const stats = [
                { label: 'Active Sites', value: DEMO_SITES.length, icon: '🏗️' },
                { label: "Today's Deliveries", value: bookings.length, icon: '🚛' },
                { label: 'Compliance Rate', value: complianceRate, icon: '✅' },
                { label: 'Violations Today', value: violationCount, icon: '🚨' },
            ];

            el.innerHTML = stats.map(s => `
                <div class="dash-card p-6 flex flex-col justify-between">
                    <div class="flex items-center justify-between mb-4">
                        <span class="text-xl">${s.icon}</span>
                        <span class="ui-label text-[#64748B]">/ Global</span>
                    </div>
                    <div>
                        <p class="text-4xl font-extrabold text-[#1C1C1C]">${s.value}</p>
                        <p class="ui-label mt-2 text-[#7A8C3E]">${s.label}</p>
                    </div>
                </div>
            `).join('');
        });
        unsubscribeListeners.push(unsub);
    } catch (e) {
        console.warn('Could not start realtime stats:', e.message);
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TAB 1: DASHBOARD (Pending Approvals + Heatmap + Audit Log)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let pendingDriversUnsubscribe = null;
async function loadPendingDrivers() {
    if (pendingDriversUnsubscribe) pendingDriversUnsubscribe();

    pendingDriversUnsubscribe = subscribeToPendingDrivers((drivers) => {
        const section = document.getElementById('pending-drivers-section');
        const container = document.getElementById('pending-drivers-list');
        const badge = document.getElementById('pending-count-badge');
        if (!section || !container) return;

        if (badge) badge.textContent = drivers.length;

        if (drivers.length === 0) {
            section.classList.add('hidden');
            return;
        }

        section.classList.remove('hidden');
        container.innerHTML = drivers.map((d, i) => {
            const regDate = d.registeredAt?.toDate ? d.registeredAt.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
            return `
            <div id="pending-${d.uid}" class="responsive-list-card flex items-center gap-6 p-6 border border-[#1C1C1C]/10 bg-white transition-all duration-300">
                <div class="flex-shrink-0 w-12 h-12 rounded-full bg-[#F8FAFC] flex items-center justify-center border border-[#1C1C1C]/10"><span class="text-xl">🚛</span></div>
                <div class="flex-1 min-w-0">
                    <p class="ui-label text-[#7A8C3E] mb-1">/ Driver Approval Required</p>
                    <p class="font-bold text-[#1C1C1C] text-lg uppercase tracking-tight">${d.name || 'Unnamed'}</p>
                    <p class="text-xs text-[#64748B] mt-1">${d.email} · <span class="text-[#E05535] font-bold">${d.truckLicense || '—'}</span></p>
                </div>
                <div class="list-actions-wrapper flex items-center gap-4 flex-shrink-0">
                    <button class="approve-driver-btn btn-primary px-6 py-3 text-[10px]" data-uid="${d.uid}" data-name="${d.name}">Approve</button>
                    <button class="reject-driver-btn border border-[#1C1C1C]/10 px-6 py-3 text-[10px] font-bold uppercase tracking-widest text-[#E05535] hover:bg-[#E05535]/5" data-uid="${d.uid}" data-name="${d.name}">Reject</button>
                </div>
            </div>`;
        }).join('');

        bindPendingActions(container, badge, section);
    });

    unsubscribeListeners.push(pendingDriversUnsubscribe);
}

function bindPendingActions(container, badge, section) {
    container.querySelectorAll('.approve-driver-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = '...';
            await approveDriver(btn.dataset.uid);
            // The realtime listener handles UI removal automatically
        });
    });
    container.querySelectorAll('.reject-driver-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm(`Reject driver "${btn.dataset.name}"?`)) return;
            btn.disabled = true; btn.textContent = '...';
            await rejectDriver(btn.dataset.uid);
            // The realtime listener handles UI removal automatically
        });
    });
}

// Audit Log
function renderAuditLog() {
    const container = document.getElementById('admin-audit-logs');
    if (!container) return;

    const styles = { critical: 'border-l-red-500 bg-red-500/5', warning: 'border-l-amber-500 bg-amber-500/5', success: 'border-l-emerald-500 bg-emerald-500/5', info: 'border-l-blue-500 bg-blue-500/5' };
    const textStyles = { critical: 'text-red-400', warning: 'text-amber-400', success: 'text-emerald-400', info: 'text-blue-400' };

    container.innerHTML = DEMO_AUDIT_LOG.map((log, i) => {
        const f = flaggedLogs.has(log.id);
        const cls = f ? 'border-l-yellow-500 bg-yellow-500/10 ring-1 ring-yellow-500/20' : styles[log.severity];
        return `
        <div id="audit-${log.id}" class="audit-log-item border-l-4 ${cls} rounded-r-xl p-4 transition-all duration-300 hover:translate-x-1">
            <div class="flex items-start gap-3">
                <span class="text-lg mt-0.5 flex-shrink-0">${log.icon}</span>
                <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                        <p class="font-semibold ${f ? 'text-yellow-400' : textStyles[log.severity]} text-sm">${log.title}</p>
                        ${f ? '<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-yellow-500/15 border border-yellow-500/20 text-yellow-400 text-[10px] font-bold uppercase tracking-wider">⚠️ Under Review</span>' : ''}
                    </div>
                    <p class="text-slate-300 text-sm mt-1 leading-relaxed">${log.detail}</p>
                    <div class="flex items-center justify-between mt-2">
                        <p class="text-slate-500 text-xs">${timeAgo(log.time)}</p>
                        ${log.severity === 'critical' ? `<button class="flag-review-btn text-xs font-medium px-3 py-1 rounded-lg transition-all duration-200 ${f ? 'bg-yellow-500/10 text-yellow-400 border border-yellow-500/20' : 'bg-slate-700/50 text-slate-400 border border-transparent hover:border-yellow-500/20 hover:text-yellow-400'}" data-log-id="${log.id}">${f ? '↩ Unflag' : '🚩 Flag'}</button>` : ''}
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.flag-review-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.logId;
            flaggedLogs.has(id) ? flaggedLogs.delete(id) : flaggedLogs.add(id);
            renderAuditLog();
        });
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TAB 2: USER MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let allDriversUnsubscribe = null;
async function loadAllDrivers() {
    if (allDriversUnsubscribe) allDriversUnsubscribe();

    allDriversUnsubscribe = subscribeToAllDrivers((drivers) => {
        const container = document.getElementById('admin-drivers-list');
        const badge = document.getElementById('driver-count-badge');
        if (!container) return;

        if (badge) badge.textContent = drivers.length;

        if (drivers.length === 0) {
            container.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">No drivers registered yet.</p>';
            return;
        }

        const statusConfig = {
            active:   { bg: 'bg-emerald-500/10', text: 'text-emerald-400', border: 'border-emerald-500/20', label: '✓ Active' },
            pending:  { bg: 'bg-amber-500/10',   text: 'text-amber-400',   border: 'border-amber-500/20',   label: '⏳ Pending' },
            rejected: { bg: 'bg-red-500/10',     text: 'text-red-400',     border: 'border-red-500/20',     label: '✕ Rejected' },
            suspended:{ bg: 'bg-slate-500/10',   text: 'text-slate-400',   border: 'border-slate-500/20',   label: '🚫 Suspended' },
        };

        container.innerHTML = drivers.map(d => {
            const sc = statusConfig[d.status] || statusConfig.pending;
            const regDate = d.registeredAt?.toDate ? d.registeredAt.toDate().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
            return `
            <div class="responsive-list-card flex items-center gap-4 p-3 rounded-xl border ${sc.border} ${sc.bg} transition-all duration-200 hover:border-white/10">
                <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500/15 to-emerald-600/5 flex items-center justify-center flex-shrink-0">
                    <span class="text-sm">🚛</span>
                </div>
                <div class="flex-1 min-w-0">
                    <p class="font-semibold text-white text-sm truncate" style="color:#1c1c1c;">${d.name || 'Unnamed'}</p>
                    <p class="text-[11px] text-slate-400 mt-0.5" style="color:#64748b;">${d.email} · <span class="font-mono text-amber-400">${d.truckLicense || '—'}</span> · ${regDate}</p>
                </div>
                <div class="list-actions-wrapper flex items-center gap-2 flex-shrink-0">
                    <span class="px-2 py-1 rounded-md text-[10px] font-bold ${sc.bg} ${sc.text} border ${sc.border}">${sc.label}</span>
                    <div class="flex gap-1 flex-shrink-0">
                        ${d.status !== 'active' ? `<button class="user-action-btn flex items-center justify-center w-7 h-7 rounded-md bg-emerald-600/15 text-emerald-400 hover:bg-emerald-600/30 transition-all" data-uid="${d.uid}" data-action="active" title="Activate"><svg style="width:16px;height:16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg></button>` : ''}
                        ${d.status !== 'suspended' ? `<button class="user-action-btn flex items-center justify-center w-7 h-7 rounded-md bg-slate-600/15 text-slate-400 hover:bg-slate-600/30 transition-all" data-uid="${d.uid}" data-action="suspended" title="Suspend"><svg style="width:16px;height:16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636"/></svg></button>` : ''}
                        ${d.status !== 'rejected' ? `<button class="user-action-btn flex items-center justify-center w-7 h-7 rounded-md bg-red-600/10 text-red-400 hover:bg-red-600/30 transition-all" data-uid="${d.uid}" data-action="rejected" title="Reject"><svg style="width:16px;height:16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>` : ''}
                    </div>
                </div>
            </div>`;
        }).join('');

        container.querySelectorAll('.user-action-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const { uid, action } = btn.dataset;
                btn.disabled = true; btn.textContent = '…';
                await updateUserStatus(uid, action);
                // No need to manually refresh as the listener handles it automatically
            });
        });
    });

    unsubscribeListeners.push(allDriversUnsubscribe);
}

async function loadAllManagers() {
    const container = document.getElementById('admin-managers-list');
    const badge = document.getElementById('manager-count-badge');
    if (!container) return;

    container.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">Loading...</p>';
    let managers = [];
    try { managers = await getAllManagers(); } catch (e) {}
    if (badge) badge.textContent = managers.length;

    if (managers.length === 0) {
        container.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">No managers registered yet.</p>';
        return;
    }

    container.innerHTML = managers.map(m => {
        const regDate = m.registeredAt?.toDate ? m.registeredAt.toDate().toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
        return `
        <div class="responsive-list-card flex items-center gap-6 p-4 border border-[#1C1C1C]/10 bg-white transition-all duration-200">
            <div class="w-10 h-10 rounded-full bg-[#F8FAFC] flex items-center justify-center flex-shrink-0 border border-[#1C1C1C]/10">
                <span class="text-sm">📋</span>
            </div>
            <div class="flex-1 min-w-0">
                <p class="font-bold text-[#1C1C1C] text-sm uppercase tracking-tight">${m.name || 'Unnamed'}</p>
                <p class="text-[10px] text-[#64748B] font-medium uppercase tracking-wider mt-1">${m.email} · Registered ${regDate}</p>
            </div>
            <div class="list-actions-wrapper flex items-center gap-4 flex-shrink-0">
                <span class="ui-label text-[#7A8C3E]">Active</span>
                <button class="user-action-btn flex items-center justify-center w-8 h-8 rounded-full border border-[#E05535]/20 text-[#E05535] hover:bg-[#E05535]/5 transition-all" data-uid="${m.uid}" data-action="suspended" title="Suspend"><svg style="width:16px;height:16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.user-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = '…';
            await updateUserStatus(btn.dataset.uid, btn.dataset.action);
            await loadAllManagers();
        });
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TAB 3: BOOKINGS MANAGEMENT
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadAllBookings() {
    const container = document.getElementById('admin-bookings-list');
    const badge = document.getElementById('booking-count-badge');
    if (!container) return;

    container.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">Loading...</p>';

    // Try Firestore first
    let bookings = [];
    try {
        const snapshot = await getDocs(collection(db, 'logistics_slots'));
        bookings = snapshot.docs.map(d => ({ firestoreId: d.id, ...d.data() }));
    } catch (e) {
        // Fallback to local bookings
        bookings = getBookings({});
    }

    if (badge) badge.textContent = bookings.length;

    if (bookings.length === 0) {
        container.innerHTML = '<p class="text-slate-500 text-sm text-center py-6">No bookings found. Slots booked from the Manager view will appear here.</p>';
        return;
    }

    const statusConfig = {
        'PENDING_ADMIN': { text: 'text-[#E05535]', bg: 'bg-[#E05535]/5', border: 'border-[#E05535]/10', dot: 'bg-[#E05535]' },
        'SCHEDULED': { text: 'text-[#7A8C3E]', bg: 'bg-[#7A8C3E]/5', border: 'border-[#7A8C3E]/10', dot: 'bg-[#7A8C3E]' },
        'EN_ROUTE':  { text: 'text-[#F4A623]', bg: 'bg-[#F4A623]/5', border: 'border-[#F4A623]/10', dot: 'bg-[#F4A623]' },
        'ARRIVED':   { text: 'text-[#1C1C1C]', bg: 'bg-[#1C1C1C]/5', border: 'border-[#1C1C1C]/10', dot: 'bg-[#1C1C1C]' },
        'COMPLETED': { text: 'text-[#64748B]', bg: 'bg-[#64748B]/5', border: 'border-[#64748B]/10', dot: 'bg-[#64748B]' },
    };

    container.innerHTML = bookings.map(b => {
        const sc = statusConfig[b.status] || statusConfig['SCHEDULED'];
        const dateStr = b.date || '—';
        const timeStr = b.time ? to12Hour(b.time) : '—';
        const isCustom = b.targetSite === '(Custom Location)' || !!b.customAddress;
        const destDisplay = b.destName || b.customAddress || b.targetSite || 'Unknown Site';
        return `
        <div class="responsive-list-card flex items-center gap-6 p-4 border border-[#1C1C1C]/10 bg-white transition-all duration-200">
            <div class="w-16 text-center border-r border-[#1C1C1C]/10 pr-6 flex-shrink-0">
                <p class="text-[10px] font-extrabold text-[#1C1C1C]">${timeStr.split(' ')[0] || ''}</p>
                <p class="text-[9px] font-bold text-[#64748B] uppercase">${timeStr.split(' ')[1] || ''}</p>
            </div>
            <div class="flex-1 min-w-0">
                <p class="ui-label text-[#7A8C3E] mb-1">/ ${isCustom ? '📌 Custom Delivery' : 'Booking Confirmed'}</p>
                <p class="font-bold text-[#1C1C1C] text-sm uppercase tracking-tight">${b.truckId || 'UNASSIGNED'}</p>
                <p class="text-[10px] text-[#64748B] font-medium mt-1 uppercase tracking-wider">${b.driver || 'No Driver'} · ${destDisplay} · ${dateStr}</p>
                <div class="mt-2 flex flex-wrap items-center gap-2">
                    ${b.material ? `<span class="px-2 py-0.5 bg-[#F8FAFC] text-[#1C1C1C] text-[9px] font-extrabold uppercase tracking-widest border border-[#1C1C1C]/10">${b.material}</span>` : ''}
                    ${isCustom ? `<span class="px-2 py-0.5 text-[9px] font-extrabold uppercase tracking-widest border" style="background:rgba(224,85,53,0.06);color:#E05535;border-color:rgba(224,85,53,0.15);">📌 Custom Point</span>` : ''}
                </div>
            </div>
            <div class="list-actions-wrapper flex items-center gap-3 flex-shrink-0 h-full">
                <div class="flex items-center gap-2 mr-2">
                    <span class="w-1.5 h-1.5 rounded-full ${sc.dot} ${b.status === 'EN_ROUTE' ? 'animate-pulse' : ''}"></span>
                    <span class="ui-label ${sc.text}">${b.status || '—'}</span>
                </div>
                ${b.status === 'PENDING_ADMIN' && b.firestoreId ? `
                    <button class="send-link-btn btn-primary px-4 py-2 text-[9px]" data-id="${b.firestoreId}">Assign Driver</button>
                ` : ''}
                ${b.firestoreId ? `
                    <button class="cancel-booking-btn flex items-center justify-center w-8 h-8 rounded-full border border-[#E05535]/20 text-[#E05535] hover:bg-[#E05535]/5 transition-all" data-id="${b.firestoreId}" title="Cancel booking"><svg style="width:16px;height:16px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg></button>
                ` : ''}
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.cancel-booking-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Cancel this booking?')) return;
            btn.disabled = true; btn.textContent = '…';
            try {
                await deleteDoc(doc(db, 'logistics_slots', btn.dataset.id));
            } catch (e) {
                cancelBooking(btn.dataset.id);
            }
            await loadAllBookings();
        });
    });

    container.querySelectorAll('.send-link-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const bookingId = btn.dataset.id;
            // Fetch the booking data from Firestore to get destination
            let bookingData = null;
            try {
                const { getDoc } = await import('../config/firebase-config.js');
                const snap = await getDoc(doc(db, 'logistics_slots', bookingId));
                if (snap.exists()) bookingData = snap.data();
            } catch (e) {}

            // Show driver assignment modal
            openDriverAssignmentModal(bookingId, bookingData);
        });
    });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TAB 4: LIVE ALERTS + COMPLIANCE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function loadLiveAlerts() {
    const container = document.getElementById('admin-live-alerts');
    if (!container) return;

    try {
        const unsub = onSnapshot(collection(db, 'live_alerts'), (snapshot) => {
            const alerts = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            // sort manually if query isn't strictly ordered
            alerts.sort((a,b) => (b.time?.toMillis?.() || 0) - (a.time?.toMillis?.() || 0));

            const liveEntries = alerts.map(a => ({
                icon: a.type === 'geofence_entry' ? '🚨' : '📍',
                title: a.title || 'Alert',
                detail: a.detail || '',
                time: a.time?.toDate ? a.time.toDate() : new Date(),
                severity: a.severity || 'info'
            }));

            const all = [...liveEntries, ...DEMO_AUDIT_LOG].slice(0, 20);
            renderLiveAlertsList(container, all);
        });
        unsubscribeListeners.push(unsub);
    } catch (e) {
        renderLiveAlertsList(container, DEMO_AUDIT_LOG);
    }
}

function renderLiveAlertsList(container, entries) {
    const styles = { 
        critical: 'border-l-[#E05535] bg-[#E05535]/5', 
        warning: 'border-l-[#F4A623] bg-[#F4A623]/5', 
        success: 'border-l-[#7A8C3E] bg-[#7A8C3E]/5', 
        info: 'border-l-[#1C1C1C] bg-[#F8FAFC]' 
    };
    const textStyles = { critical: 'text-[#E05535]', warning: 'text-[#F4A623]', success: 'text-[#7A8C3E]', info: 'text-[#1C1C1C]' };

    container.innerHTML = entries.map((e, i) => `
        <div class="border-l-4 ${styles[e.severity] || styles.info} p-3 transition-all duration-300 hover:translate-x-1" style="animation-delay:${i*50}ms">
            <div class="flex items-start gap-3">
                <span class="text-base mt-1 flex-shrink-0">${e.icon}</span>
                <div class="flex-1 min-w-0">
                    <p class="ui-label ${textStyles[e.severity] || textStyles.info} text-[10px] mb-1">/ Live Alert</p>
                    <p class="font-bold text-[#1C1C1C] text-xs uppercase tracking-tight">${e.title}</p>
                    <p class="text-[#64748B] text-xs mt-1 leading-relaxed">${e.detail}</p>
                    <p class="text-[#64748B] text-[9px] mt-2 font-bold uppercase opacity-50">${timeAgo(e.time)}</p>
                </div>
            </div>
        </div>
    `).join('');
}

async function loadComplianceRecords() {
    const container = document.getElementById('admin-compliance-list');
    const badge = document.getElementById('compliance-count-badge');
    if (!container) return;

    container.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">Loading...</p>';

    let records = [];
    try {
        const snapshot = await getDocs(collection(db, 'compliance_records'));
        records = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    } catch (e) {}

    if (badge) badge.textContent = records.length;

    if (records.length === 0) {
        container.innerHTML = `
            <div class="text-center py-8">
                <span class="text-3xl block mb-3">📸</span>
                <p class="text-slate-500 text-sm">No compliance records yet.</p>
                <p class="text-slate-600 text-xs mt-1">Photos uploaded by drivers during delivery will appear here.</p>
            </div>`;
        return;
    }

    container.innerHTML = records.map(r => {
        const uploadDate = r.uploadedAt?.toDate ? r.uploadedAt.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
        return `
        <div class="responsive-list-card flex items-center gap-6 p-4 border border-[#1C1C1C]/10 bg-white transition-all">
            <div class="w-10 h-10 rounded-full bg-[#F8FAFC] flex items-center justify-center flex-shrink-0 border border-[#1C1C1C]/10">
                <span class="text-sm">📸</span>
            </div>
            <div class="flex-1 min-w-0">
                <p class="ui-label text-[#7A8C3E] mb-1">/ Compliance Verification</p>
                <p class="font-bold text-[#1C1C1C] text-xs uppercase tracking-tight">Booking: ${r.bookingId || '—'}</p>
                <p class="text-[9px] text-[#64748B] font-bold uppercase mt-1">${uploadDate} · ${r.verified ? '✅ Verified' : '⏳ Pending'}</p>
            </div>
            <div class="list-actions-wrapper flex flex-shrink-0">
                ${r.url ? `<a href="${r.url}" target="_blank" class="px-4 py-2 border border-[#1C1C1C]/10 text-[#1C1C1C] text-[9px] font-extrabold uppercase tracking-widest hover:bg-[#F8FAFC] transition-all">View Photo</a>` : ''}
            </div>
        </div>`;
    }).join('');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  HEATMAP
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function initHeatmap() {
    const mapContainer = document.getElementById('admin-map');
    if (!mapContainer) return;

    try { await initMaps(); } catch (e) {
        mapContainer.innerHTML = `<div class="flex items-center justify-center h-full bg-slate-800/50 rounded-xl"><div class="text-center p-8"><span class="text-4xl block mb-4">🗺️</span><p class="text-slate-300 font-medium">Map failed to load</p></div></div>`;
        return;
    }

    adminMap = L.map(mapContainer, { center: [MIRA_BHAYANDAR_CENTER.lat, MIRA_BHAYANDAR_CENTER.lng], zoom: 13, zoomControl: true, attributionControl: false });
    L.tileLayer(STANDARD_TILE_URL, { attribution: STANDARD_TILE_ATTRIBUTION, maxZoom: 19 }).addTo(adminMap);

    const heatData = [];
    DEMO_SITES.forEach(site => {
        for (let i = 0; i < 10; i++) {
            heatData.push([site.lat + (Math.random() - 0.5) * 0.008, site.lng + (Math.random() - 0.5) * 0.008, Math.random() * 0.8 + 0.3]);
        }
    });

    if (window.L && L.heatLayer) {
        L.heatLayer(heatData, { radius: 30, blur: 20, maxZoom: 17, gradient: { 0.2: '#7A8C3E', 0.5: '#F4A623', 0.8: '#E05535', 1.0: '#E05535' } }).addTo(adminMap);
    }

    DEMO_SITES.forEach(site => {
        L.marker([site.lat, site.lng], {
            icon: L.divIcon({ className: '', html: `<div style="width:16px;height:16px;background:#7A8C3E;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(122,140,62,0.4)"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] })
        }).addTo(adminMap).bindPopup(`<div style="font-family:'Inter',sans-serif;padding:4px"><strong style="font-size:13px">${site.name}</strong><br><span style="color:#64748B;font-size:12px">Road: ${site.road}</span><br><span style="color:#7A8C3E;font-size:12px;font-weight:700">STATUS: ACTIVE SITE</span></div>`);
    });

    setTimeout(() => {
        adminMap.invalidateSize();
        startRealtimeTruckTracking();
    }, 200);
}

// ─── Realtime Truck Tracking for Admin ──────────────────────────────────

function startRealtimeTruckTracking() {
    if (!adminMap) return;

    const unsub = listenToActiveTrucks((trucks) => {
        reconcileTruckMarkers(trucks);
    });
    unsubscribeListeners.push(unsub);
}

function reconcileTruckMarkers(trucks) {
    if (!adminMap) return;

    const currentIds = new Set(trucks.map(t => t.id));

    // Add or update markers
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

        if (truckMarkers[truck.id]) {
            truckMarkers[truck.id].setLatLng([truck.lat, truck.lng]);
            truckMarkers[truck.id].setPopupContent(popupContent);
        } else {
            const icon = createTruckIcon();
            const marker = L.marker([truck.lat, truck.lng], { icon }).addTo(adminMap);
            marker.bindPopup(popupContent);
            truckMarkers[truck.id] = marker;
        }

        // Draw/Update routing path (road-following via OSRM)
        if (truck.destLat && truck.destLng) {
            // Remove old route if truck has moved
            if (truckPaths[truck.id]) {
                try { truckPaths[truck.id].remove(); } catch(e) {}
                try { adminMap.removeLayer(truckPaths[truck.id]); } catch(e) {}
                delete truckPaths[truck.id];
            }
            
            truckPaths[truck.id] = addRoadRoute(
                adminMap,
                [truck.lat, truck.lng],
                [truck.destLat, truck.destLng],
                { color: '#8b5cf6', weight: 4, opacity: 0.6 }
            );

            // Dynamic destination marker + geofence circle (auto-removed when truck goes offline)
            const destKey = `dest_${truck.destLat.toFixed(4)}_${truck.destLng.toFixed(4)}`;
            if (!truckMarkers[destKey]) {
                // Destination marker
                const destIcon = L.divIcon({
                    className: 'dest-pin-dynamic',
                    html: `<div style="width:22px;height:22px;background:#E05535;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(224,85,53,0.4);display:flex;align-items:center;justify-content:center;">
                             <div style="width:5px;height:5px;background:#fff;border-radius:50%;"></div>
                           </div>`,
                    iconSize: [22, 22],
                    iconAnchor: [11, 11]
                });
                truckMarkers[destKey] = L.marker([truck.destLat, truck.destLng], { icon: destIcon })
                    .addTo(adminMap)
                    .bindPopup(`<div style="font-family:Inter,sans-serif;padding:4px;"><strong style="font-size:12px;">📍 Delivery Destination</strong><br><span style="color:#E05535;font-size:11px;font-weight:600;">Driver: ${truck.driver || 'Unknown'}</span></div>`);
            }

            // Temporary geofence circle around destination
            const circleKey = `circle_${truck.destLat.toFixed(4)}_${truck.destLng.toFixed(4)}`;
            if (!truckPaths[circleKey]) {
                truckPaths[circleKey] = L.circle([truck.destLat, truck.destLng], {
                    radius: 500,
                    color: '#7A8C3E',
                    fillColor: '#7A8C3E',
                    fillOpacity: 0.08,
                    weight: 1,
                    dashArray: '6, 4'
                }).addTo(adminMap);
            }
        }
    });

    // Remove markers, paths, dest markers, and circles for trucks that went offline
    for (const id of Object.keys(truckMarkers)) {
        if (!currentIds.has(id) && !id.startsWith('dest_')) {
            adminMap.removeLayer(truckMarkers[id]);
            delete truckMarkers[id];

            if (truckPaths[id]) {
                try { truckPaths[id].remove(); } catch(e) {}
                try { adminMap.removeLayer(truckPaths[id]); } catch(e) {}
                delete truckPaths[id];
            }
        }
    }

    // Clean up destination markers and circles that no longer have active trucks
    const activeDestKeys = new Set();
    trucks.forEach(t => {
        if (t.destLat && t.destLng) {
            activeDestKeys.add(`${t.destLat.toFixed(4)}_${t.destLng.toFixed(4)}`);
        }
    });
    for (const key of Object.keys(truckMarkers)) {
        if (key.startsWith('dest_')) {
            const coordKey = key.replace('dest_', '');
            if (!activeDestKeys.has(coordKey)) {
                try { adminMap.removeLayer(truckMarkers[key]); } catch(e) {}
                delete truckMarkers[key];
            }
        }
    }
    for (const key of Object.keys(truckPaths)) {
        if (key.startsWith('circle_')) {
            const coordKey = key.replace('circle_', '');
            if (!activeDestKeys.has(coordKey)) {
                try { adminMap.removeLayer(truckPaths[key]); } catch(e) {}
                delete truckPaths[key];
            }
        }
    }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  DRIVER ASSIGNMENT MODAL (Production — Real Driver Selection)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

let assignmentMap = null;

/**
 * Opens the driver assignment modal for a pending booking.
 * Fetches all active drivers with their GPS locations from Firestore,
 * calculates distance to the booking destination, and recommends the nearest.
 */
async function openDriverAssignmentModal(bookingId, bookingData) {
    // Get or create the modal
    let modal = document.getElementById('driver-assign-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'driver-assign-modal';
        document.body.appendChild(modal);
    }

    // Determine destination coordinates
    let destLat = bookingData?.destLat || bookingData?.customLat || null;
    let destLng = bookingData?.destLng || bookingData?.customLng || null;
    let destName = bookingData?.destName || bookingData?.targetSite || 'Unknown Site';

    // If no destLat/destLng, try to infer from targetSite
    if (!destLat || !destLng) {
        const site = DEMO_SITES.find(s => s.name === bookingData?.targetSite);
        if (site) {
            destLat = site.lat;
            destLng = site.lng;
            destName = site.name;
        }
    }

    // Show loading state
    modal.style.cssText = 'position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:1rem;background:rgba(0,0,0,0.6);backdrop-filter:blur(12px);';
    modal.innerHTML = `
        <div style="background:#fff;border-radius:1.5rem;max-width:64rem;width:100%;max-height:92vh;overflow-y:auto;padding:2rem;box-shadow:0 25px 50px rgba(0,0,0,0.25);">
            <div style="display:flex;align-items:center;justify-content:center;padding:4rem;">
                <div style="text-align:center;">
                    <span style="display:inline-block;width:32px;height:32px;border:3px solid rgba(28,28,28,0.15);border-top-color:#7A8C3E;border-radius:50%;animation:spin 1s linear infinite;"></span>
                    <p style="margin-top:1rem;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748B;">Loading available drivers...</p>
                </div>
            </div>
        </div>
    `;

    // Fetch drivers with locations
    const drivers = await getDriversWithLocations();

    // Calculate distance for each driver (if they have a location and we have a destination)
    const driversWithDistance = drivers.map(driver => {
        let distanceKm = null;
        if (driver.lastLocation && destLat && destLng) {
            distanceKm = calculateDistance(
                driver.lastLocation.lat,
                driver.lastLocation.lng,
                destLat,
                destLng
            );
        }
        return { ...driver, distanceKm };
    });

    // Sort by distance (nearest first), drivers without location at the end
    driversWithDistance.sort((a, b) => {
        if (a.distanceKm !== null && b.distanceKm !== null) return a.distanceKm - b.distanceKm;
        if (a.distanceKm !== null) return -1;
        if (b.distanceKm !== null) return 1;
        return 0;
    });

    // Render the full modal
    const bookingTimeStr = bookingData?.time || '';
    const bookingDateStr = bookingData?.date || '';
    const materialStr = bookingData?.material || '';

    modal.innerHTML = `
        <div style="background:#fff;border-radius:1.5rem;max-width:64rem;width:100%;max-height:92vh;overflow-y:auto;box-shadow:0 25px 50px rgba(0,0,0,0.25);">
            <!-- Header -->
            <div style="padding:2rem 2rem 0;display:flex;align-items:center;justify-content:space-between;">
                <div>
                    <p style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.12em;color:#7A8C3E;margin-bottom:0.5rem;">/ Smart Assignment</p>
                    <h3 style="font-family:'Satoshi','Inter',sans-serif;font-size:24px;font-weight:900;color:#1C1C1C;letter-spacing:-0.03em;text-transform:uppercase;">SELECT DRIVER</h3>
                </div>
                <button id="close-assign-modal" style="width:40px;height:40px;border-radius:50%;border:1px solid rgba(28,28,28,0.1);background:none;cursor:pointer;display:flex;align-items:center;justify-content:center;color:#64748B;transition:all 0.2s;" onmouseover="this.style.background='#f1f5f9'" onmouseout="this.style.background='none'">
                    <svg style="width:20px;height:20px;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12"/></svg>
                </button>
            </div>

            <!-- Booking Info Strip -->
            <div style="margin:1.5rem 2rem;padding:1rem 1.25rem;background:#F7F8F5;border:1px solid rgba(28,28,28,0.06);display:flex;gap:2rem;flex-wrap:wrap;align-items:center;">
                <div>
                    <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748B;">Destination</span>
                    <p style="font-weight:800;color:#1C1C1C;font-size:14px;margin-top:2px;">${destName}</p>
                </div>
                ${bookingTimeStr ? `<div>
                    <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748B;">Time</span>
                    <p style="font-weight:800;color:#1C1C1C;font-size:14px;margin-top:2px;">${bookingTimeStr}</p>
                </div>` : ''}
                ${materialStr ? `<div>
                    <span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.1em;color:#64748B;">Material</span>
                    <p style="font-weight:800;color:#1C1C1C;font-size:14px;margin-top:2px;">${materialStr}</p>
                </div>` : ''}
            </div>

            <!-- Content Grid -->
            <div style="padding:0 2rem 2rem;display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;">
                <!-- Driver List -->
                <div style="max-height:420px;overflow-y:auto;display:flex;flex-direction:column;gap:0.75rem;" id="driver-assignment-list">
                    ${driversWithDistance.length === 0 ? `
                        <div style="text-align:center;padding:3rem;">
                            <span style="font-size:40px;display:block;margin-bottom:1rem;">🚫</span>
                            <p style="font-weight:700;color:#1C1C1C;font-size:14px;">No Active Drivers</p>
                            <p style="color:#64748B;font-size:12px;margin-top:0.5rem;">No approved drivers are currently available. Approve pending driver registrations first.</p>
                        </div>
                    ` : driversWithDistance.map((driver, idx) => {
                        const isNearest = idx === 0 && driver.distanceKm !== null;
                        const hasLocation = driver.lastLocation !== null;
                        const distStr = driver.distanceKm !== null ? `${driver.distanceKm.toFixed(1)} km` : 'Location unavailable';
                        const locationAge = hasLocation && driver.lastLocation.updatedAt?.toDate
                            ? timeAgo(driver.lastLocation.updatedAt.toDate())
                            : hasLocation ? 'Recently' : '—';

                        return `
                        <div class="driver-assign-card" data-uid="${driver.uid}" data-name="${driver.name}" data-mobile="${driver.mobile}" data-license="${driver.truckLicense}" 
                             style="padding:1rem 1.25rem;border:${isNearest ? '2px solid #7A8C3E' : '1px solid rgba(28,28,28,0.1)'};background:${isNearest ? 'rgba(122,140,62,0.04)' : '#fff'};cursor:pointer;transition:all 0.2s;position:relative;"
                             onmouseover="this.style.borderColor='#7A8C3E';this.style.transform='translateX(4px)'" 
                             onmouseout="this.style.borderColor='${isNearest ? '#7A8C3E' : 'rgba(28,28,28,0.1)'}';this.style.transform='none'">
                            ${isNearest ? `<span style="position:absolute;top:-8px;right:12px;background:#7A8C3E;color:#fff;padding:2px 10px;font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;">⭐ Nearest</span>` : ''}
                            <div style="display:flex;align-items:center;gap:1rem;">
                                <div style="width:40px;height:40px;border-radius:50%;background:${hasLocation ? 'rgba(122,140,62,0.1)' : 'rgba(100,116,139,0.1)'};display:flex;align-items:center;justify-content:center;flex-shrink:0;">
                                    <span style="font-size:18px;">${hasLocation ? '📍' : '👤'}</span>
                                </div>
                                <div style="flex:1;min-width:0;">
                                    <p style="font-weight:800;color:#1C1C1C;font-size:13px;text-transform:uppercase;letter-spacing:-0.01em;">${driver.name}</p>
                                    <p style="font-size:10px;color:#64748B;margin-top:2px;">
                                        ${driver.mobile ? `📱 ${driver.mobile}` : driver.email}
                                        ${driver.truckLicense ? ` · <span style="color:#E05535;font-weight:700;">${driver.truckLicense}</span>` : ''}
                                    </p>
                                </div>
                                <div style="text-align:right;flex-shrink:0;">
                                    <p style="font-weight:800;color:${hasLocation ? '#7A8C3E' : '#94A3B8'};font-size:${hasLocation ? '16px' : '11px'};">${distStr}</p>
                                    ${hasLocation ? `<p style="font-size:9px;color:#94A3B8;margin-top:2px;">Updated ${locationAge}</p>` : ''}
                                </div>
                            </div>
                        </div>`;
                    }).join('')}
                </div>

                <!-- Mini Map -->
                <div style="display:flex;flex-direction:column;">
                    <p style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:0.12em;color:#64748B;margin-bottom:0.75rem;">/ Driver Positions</p>
                    <div id="assign-mini-map" style="flex:1;min-height:380px;background:#F7F8F5;border:1px solid rgba(28,28,28,0.08);"></div>
                </div>
            </div>
        </div>
    `;

    // Bind close button
    document.getElementById('close-assign-modal')?.addEventListener('click', () => {
        closeDriverAssignmentModal();
    });

    // Click outside to close
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDriverAssignmentModal();
    });

    // Bind driver card clicks
    document.querySelectorAll('.driver-assign-card').forEach(card => {
        card.addEventListener('click', async () => {
            const driverName = card.dataset.name;
            const driverMobile = card.dataset.mobile;
            const driverLicense = card.dataset.license;

            // Disable all cards
            document.querySelectorAll('.driver-assign-card').forEach(c => {
                c.style.pointerEvents = 'none';
                c.style.opacity = '0.5';
            });
            card.style.opacity = '1';
            card.style.border = '2px solid #7A8C3E';
            card.innerHTML += `<div style="position:absolute;inset:0;background:rgba(122,140,62,0.08);display:flex;align-items:center;justify-content:center;"><span style="display:inline-block;width:20px;height:20px;border:2px solid rgba(28,28,28,0.15);border-top-color:#7A8C3E;border-radius:50%;animation:spin 1s linear infinite;"></span> <span style="margin-left:8px;font-size:11px;font-weight:700;color:#7A8C3E;">ASSIGNING...</span></div>`;

            // Assign driver
            const truckId = driverLicense || 'Pending';
            const trackingToken = await assignDriverAndSendLink(bookingId, driverName, truckId);

            // Build WhatsApp link
            const link = `${window.location.origin}${window.location.pathname}?track_token=${trackingToken}`;
            const cleanMobile = (driverMobile || '').replace(/[^0-9]/g, '');
            const phoneForWA = cleanMobile.startsWith('91') ? cleanMobile : `91${cleanMobile}`;
            const message = encodeURIComponent(
                `Hi ${driverName},\n\nYou have been assigned a new construction delivery trip.\n📍 Destination: ${destName}\n📅 Date: ${bookingDateStr}\n⏰ Time: ${bookingTimeStr}\n🚧 Material: ${materialStr}\n\n🔗 Start Tracking: ${link}\n\n— LogiSafe Dispatch`
            );
            const waUrl = `https://wa.me/${phoneForWA}?text=${message}`;

            // Show success and WhatsApp prompt
            modal.querySelector('.driver-assign-card[data-uid="' + card.dataset.uid + '"]').innerHTML = `
                <div style="display:flex;align-items:center;gap:1rem;padding:0.5rem;">
                    <div style="width:40px;height:40px;border-radius:50%;background:rgba(122,140,62,0.15);display:flex;align-items:center;justify-content:center;">
                        <svg style="width:20px;height:20px;color:#7A8C3E;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/></svg>
                    </div>
                    <div>
                        <p style="font-weight:800;color:#7A8C3E;font-size:13px;">ASSIGNED: ${driverName}</p>
                        <p style="font-size:10px;color:#64748B;margin-top:2px;">${driverLicense} · Tracking link generated</p>
                    </div>
                </div>
            `;

            // Open WhatsApp
            if (confirm(`✅ ${driverName} assigned successfully!\n\nOpen WhatsApp to send the tracking link to ${driverMobile || 'driver'}?`)) {
                window.open(waUrl, '_blank');
            }

            // Close modal and refresh bookings
            setTimeout(async () => {
                closeDriverAssignmentModal();
                await loadAllBookings();
            }, 1500);
        });
    });

    // Initialize mini-map
    setTimeout(() => {
        initAssignmentMiniMap(driversWithDistance, destLat, destLng, destName);
    }, 300);
}

/**
 * Initialize the mini-map inside the driver assignment modal.
 * Shows all driver positions and the booking destination.
 */
async function initAssignmentMiniMap(drivers, destLat, destLng, destName) {
    const container = document.getElementById('assign-mini-map');
    if (!container) return;

    try {
        await initMaps();
    } catch (e) {
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;"><p style="color:#64748B;font-size:12px;">Map unavailable</p></div>';
        return;
    }

    // Clean up old map
    if (assignmentMap) { assignmentMap.remove(); assignmentMap = null; }

    const center = destLat && destLng ? [destLat, destLng] : [MIRA_BHAYANDAR_CENTER.lat, MIRA_BHAYANDAR_CENTER.lng];

    assignmentMap = L.map(container, {
        center: center,
        zoom: 13,
        zoomControl: true,
        attributionControl: false
    });

    L.tileLayer(STANDARD_TILE_URL, {
        attribution: STANDARD_TILE_ATTRIBUTION,
        maxZoom: 19
    }).addTo(assignmentMap);

    // Add destination marker
    if (destLat && destLng) {
        const destIcon = L.divIcon({
            className: 'dest-marker',
            html: `<div style="width:28px;height:28px;background:#7A8C3E;border:3px solid #fff;border-radius:50%;box-shadow:0 0 15px rgba(122,140,62,0.5);display:flex;align-items:center;justify-content:center;">
                     <span style="font-size:12px;">🏗️</span>
                   </div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14]
        });
        L.marker([destLat, destLng], { icon: destIcon })
            .addTo(assignmentMap)
            .bindPopup(`<div style="font-family:Inter,sans-serif;padding:4px;"><strong style="font-size:12px;">📍 ${destName}</strong><br><span style="color:#7A8C3E;font-size:11px;font-weight:600;">DESTINATION</span></div>`);

        // Add geofence circle
        L.circle([destLat, destLng], {
            radius: 500,
            color: '#7A8C3E',
            fillColor: '#7A8C3E',
            fillOpacity: 0.08,
            weight: 1,
            dashArray: '6, 4'
        }).addTo(assignmentMap);
    }

    // Add driver markers
    const bounds = [];
    if (destLat && destLng) bounds.push([destLat, destLng]);

    drivers.forEach((driver, idx) => {
        if (!driver.lastLocation) return;
        const { lat, lng } = driver.lastLocation;
        const isNearest = idx === 0;

        const driverIcon = L.divIcon({
            className: 'driver-map-marker',
            html: `<div style="width:${isNearest ? '32' : '26'}px;height:${isNearest ? '32' : '26'}px;background:${isNearest ? '#E05535' : '#1C1C1C'};border:${isNearest ? '3px' : '2px'} solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 10px rgba(0,0,0,${isNearest ? '0.3' : '0.2'});">
                     <span style="font-size:${isNearest ? '14' : '12'}px;">🚛</span>
                   </div>`,
            iconSize: [isNearest ? 32 : 26, isNearest ? 32 : 26],
            iconAnchor: [isNearest ? 16 : 13, isNearest ? 16 : 13]
        });

        const distStr = driver.distanceKm !== null ? `${driver.distanceKm.toFixed(1)} km away` : '';

        L.marker([lat, lng], { icon: driverIcon })
            .addTo(assignmentMap)
            .bindPopup(`<div style="font-family:Inter,sans-serif;padding:4px;">
                <strong style="font-size:12px;">${driver.name}</strong>
                ${isNearest ? '<br><span style="color:#E05535;font-size:10px;font-weight:700;">⭐ RECOMMENDED</span>' : ''}
                ${distStr ? `<br><span style="color:#64748B;font-size:11px;">${distStr}</span>` : ''}
                ${driver.truckLicense ? `<br><span style="color:#E05535;font-size:11px;font-weight:600;">${driver.truckLicense}</span>` : ''}
            </div>`);

        bounds.push([lat, lng]);
    });

    // Fit bounds to show all markers
    if (bounds.length > 1) {
        assignmentMap.fitBounds(bounds, { padding: [40, 40] });
    }

    setTimeout(() => assignmentMap.invalidateSize(), 200);
}

/**
 * Close and cleanup the driver assignment modal.
 */
function closeDriverAssignmentModal() {
    const modal = document.getElementById('driver-assign-modal');
    if (modal) modal.remove();
    if (assignmentMap) {
        assignmentMap.remove();
        assignmentMap = null;
    }
}
