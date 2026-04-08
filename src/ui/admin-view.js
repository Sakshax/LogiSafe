/**
 * admin-view.js — Full Admin Portal Controller v4
 *
 * Tabbed interface:
 *  TAB 1: Dashboard — Heatmap + Pending Approvals + Audit Log
 *  TAB 2: Users — All Drivers (approve/reject/suspend) + All Managers
 *  TAB 3: Bookings — All logistics slots from Firestore with cancel
 *  TAB 4: Live Alerts + Compliance Records from Firestore
 */

import { initMaps, DARK_TILE_URL, DARK_TILE_ATTRIBUTION, MIRA_BHAYANDAR_CENTER, DEMO_SITES } from '../config/maps-config.js';
import { getBookings, cancelBooking } from '../modules/scheduler.js';
import {
    getPendingDrivers, approveDriver, rejectDriver,
    getAllDrivers, getAllManagers, updateUserStatus
} from '../modules/auth.js';
import {
    db, collection, getDocs, query, where, orderBy, onSnapshot, deleteDoc, doc
} from '../config/firebase-config.js';
import { timeAgo, todayISO, to12Hour } from '../utils/formatters.js';

let adminMap = null;
let initialized = false;
let unsubscribeListeners = [];

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
}

export function destroyAdminView() {
    if (adminMap) { adminMap.remove(); adminMap = null; }
    unsubscribeListeners.forEach(fn => fn());
    unsubscribeListeners = [];
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
        t.classList.remove('bg-blue-600', 'text-white', 'shadow-lg');
        t.classList.add('text-slate-400');
    });
    const activeTab = document.querySelector(`.admin-tab[data-tab="${tab}"]`);
    if (activeTab) {
        activeTab.classList.add('bg-blue-600', 'text-white', 'shadow-lg');
        activeTab.classList.remove('text-slate-400');
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
        { label: 'Active Sites', value: DEMO_SITES.length, icon: '🏗️', color: 'from-blue-500/20 to-blue-600/5', text: 'text-blue-400' },
        { label: "Today's Deliveries", value: bookings.length, icon: '🚛', color: 'from-emerald-500/20 to-emerald-600/5', text: 'text-emerald-400' },
        { label: 'Compliance Rate', value: '94%', icon: '✅', color: 'from-amber-500/20 to-amber-600/5', text: 'text-amber-400' },
        { label: 'Violations Today', value: violationCount, icon: '🚨', color: 'from-red-500/20 to-red-600/5', text: 'text-red-400' },
    ];

    el.innerHTML = stats.map(s => `
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TAB 1: DASHBOARD (Pending Approvals + Heatmap + Audit Log)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function loadPendingDrivers() {
    const section = document.getElementById('pending-drivers-section');
    const container = document.getElementById('pending-drivers-list');
    const badge = document.getElementById('pending-count-badge');
    if (!section || !container) return;

    let drivers = [];
    try { drivers = await getPendingDrivers(); } catch (e) {}

    if (badge) badge.textContent = drivers.length;

    if (drivers.length === 0) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    container.innerHTML = drivers.map((d, i) => {
        const regDate = d.registeredAt?.toDate ? d.registeredAt.toDate().toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
        return `
        <div id="pending-${d.uid}" class="flex items-center gap-4 p-4 rounded-xl border border-amber-500/10 bg-amber-500/5 transition-all duration-300">
            <div class="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500/20 to-orange-600/10 flex items-center justify-center border border-amber-500/20"><span class="text-lg">🚛</span></div>
            <div class="flex-1 min-w-0">
                <p class="font-semibold text-white text-sm truncate">${d.name || 'Unnamed'}</p>
                <p class="text-xs text-slate-400 mt-0.5">${d.email} · <span class="text-amber-400 font-mono">${d.truckLicense || '—'}</span></p>
                <p class="text-[10px] text-slate-500 mt-1">${regDate}</p>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
                <button class="approve-driver-btn flex items-center gap-1.5 px-3 py-2 rounded-lg bg-emerald-600/20 border border-emerald-500/20 text-emerald-400 text-xs font-semibold hover:bg-emerald-600/40 transition-all active:scale-95" data-uid="${d.uid}" data-name="${d.name}">✓ Approve</button>
                <button class="reject-driver-btn flex items-center gap-1.5 px-3 py-2 rounded-lg bg-red-600/10 border border-red-500/20 text-red-400 text-xs font-semibold hover:bg-red-600/30 transition-all active:scale-95" data-uid="${d.uid}" data-name="${d.name}">✕ Reject</button>
            </div>
        </div>`;
    }).join('');

    bindPendingActions(container, badge, section);
}

function bindPendingActions(container, badge, section) {
    container.querySelectorAll('.approve-driver-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true; btn.textContent = '...';
            const res = await approveDriver(btn.dataset.uid);
            if (res.success) fadeAndRemove(btn.dataset.uid, 'pending', badge, section);
        });
    });
    container.querySelectorAll('.reject-driver-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm(`Reject driver "${btn.dataset.name}"?`)) return;
            btn.disabled = true; btn.textContent = '...';
            const res = await rejectDriver(btn.dataset.uid);
            if (res.success) fadeAndRemove(btn.dataset.uid, 'pending', badge, section);
        });
    });
}

function fadeAndRemove(uid, prefix, badge, section) {
    const row = document.getElementById(`${prefix}-${uid}`);
    if (row) {
        row.style.opacity = '0'; row.style.transform = 'translateX(20px)';
        setTimeout(() => row.remove(), 300);
        const c = parseInt(badge?.textContent || '0');
        if (badge) badge.textContent = Math.max(0, c - 1);
        if (c - 1 <= 0 && section) section.classList.add('hidden');
    }
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

async function loadAllDrivers() {
    const container = document.getElementById('admin-drivers-list');
    const badge = document.getElementById('driver-count-badge');
    if (!container) return;

    container.innerHTML = '<p class="text-slate-500 text-sm text-center py-4">Loading...</p>';
    let drivers = [];
    try { drivers = await getAllDrivers(); } catch (e) {}
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
        <div class="flex items-center gap-4 p-3 rounded-xl border ${sc.border} ${sc.bg} transition-all duration-200 hover:border-white/10">
            <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500/15 to-emerald-600/5 flex items-center justify-center flex-shrink-0">
                <span class="text-sm">🚛</span>
            </div>
            <div class="flex-1 min-w-0">
                <p class="font-semibold text-white text-sm truncate">${d.name || 'Unnamed'}</p>
                <p class="text-[11px] text-slate-400 mt-0.5">${d.email} · <span class="font-mono text-amber-400">${d.truckLicense || '—'}</span> · ${regDate}</p>
            </div>
            <span class="px-2 py-1 rounded-md text-[10px] font-bold ${sc.bg} ${sc.text} border ${sc.border}">${sc.label}</span>
            <div class="flex gap-1 flex-shrink-0">
                ${d.status !== 'active' ? `<button class="user-action-btn px-2 py-1 rounded-md bg-emerald-600/15 text-emerald-400 text-[10px] font-semibold hover:bg-emerald-600/30 transition-all" data-uid="${d.uid}" data-action="active" title="Activate">✓</button>` : ''}
                ${d.status !== 'suspended' ? `<button class="user-action-btn px-2 py-1 rounded-md bg-slate-600/15 text-slate-400 text-[10px] font-semibold hover:bg-slate-600/30 transition-all" data-uid="${d.uid}" data-action="suspended" title="Suspend">🚫</button>` : ''}
                ${d.status !== 'rejected' ? `<button class="user-action-btn px-2 py-1 rounded-md bg-red-600/10 text-red-400 text-[10px] font-semibold hover:bg-red-600/30 transition-all" data-uid="${d.uid}" data-action="rejected" title="Reject">✕</button>` : ''}
            </div>
        </div>`;
    }).join('');

    container.querySelectorAll('.user-action-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const { uid, action } = btn.dataset;
            btn.disabled = true; btn.textContent = '…';
            await updateUserStatus(uid, action);
            await loadAllDrivers(); // Refresh
        });
    });
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
        <div class="flex items-center gap-4 p-3 rounded-xl border border-blue-500/20 bg-blue-500/5 transition-all duration-200 hover:border-white/10">
            <div class="w-9 h-9 rounded-lg bg-gradient-to-br from-blue-500/15 to-blue-600/5 flex items-center justify-center flex-shrink-0">
                <span class="text-sm">📋</span>
            </div>
            <div class="flex-1 min-w-0">
                <p class="font-semibold text-white text-sm truncate">${m.name || 'Unnamed'}</p>
                <p class="text-[11px] text-slate-400 mt-0.5">${m.email} · Registered ${regDate}</p>
            </div>
            <span class="px-2 py-1 rounded-md text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">✓ Active</span>
            <button class="user-action-btn px-2 py-1 rounded-md bg-red-600/10 text-red-400 text-[10px] font-semibold hover:bg-red-600/30 transition-all" data-uid="${m.uid}" data-action="suspended" title="Suspend">🚫</button>
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
        'SCHEDULED': { text: 'text-blue-400', bg: 'bg-blue-500/5', border: 'border-blue-500/15', dot: 'bg-blue-400' },
        'EN_ROUTE':  { text: 'text-amber-400', bg: 'bg-amber-500/5', border: 'border-amber-500/15', dot: 'bg-amber-400' },
        'ARRIVED':   { text: 'text-emerald-400', bg: 'bg-emerald-500/5', border: 'border-emerald-500/15', dot: 'bg-emerald-400' },
        'COMPLETED': { text: 'text-slate-400', bg: 'bg-slate-500/5', border: 'border-slate-500/15', dot: 'bg-slate-400' },
    };

    container.innerHTML = bookings.map(b => {
        const sc = statusConfig[b.status] || statusConfig['SCHEDULED'];
        const dateStr = b.date || '—';
        const timeStr = b.time ? to12Hour(b.time) : '—';
        return `
        <div class="flex items-center gap-4 p-3 rounded-xl border ${sc.border} ${sc.bg} transition-all duration-200 hover:border-white/10">
            <div class="w-14 text-center flex-shrink-0">
                <p class="text-sm font-bold text-white">${timeStr.split(' ')[0] || ''}</p>
                <p class="text-[10px] ${sc.text}">${timeStr.split(' ')[1] || ''}</p>
            </div>
            <div class="w-px h-10 bg-white/5"></div>
            <div class="flex-1 min-w-0">
                <p class="font-semibold text-white text-sm truncate">${b.truckId || '—'}</p>
                <p class="text-[11px] text-slate-400 mt-0.5">${b.driver || 'Unassigned'} · ${b.road || '—'} · ${dateStr}</p>
            </div>
            <div class="flex items-center gap-2 flex-shrink-0">
                <span class="w-2 h-2 rounded-full ${sc.dot} ${b.status === 'EN_ROUTE' ? 'animate-pulse' : ''}"></span>
                <span class="text-[10px] font-medium ${sc.text}">${b.status || '—'}</span>
            </div>
            ${b.firestoreId ? `
                <button class="cancel-booking-btn px-2 py-1 rounded-md bg-red-600/10 text-red-400 text-[10px] font-semibold hover:bg-red-600/30 transition-all" data-id="${b.firestoreId}" title="Cancel booking">✕</button>
            ` : ''}
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
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
//  TAB 4: LIVE ALERTS + COMPLIANCE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function loadLiveAlerts() {
    const container = document.getElementById('admin-live-alerts');
    if (!container) return;

    // Try real-time Firestore listener for active trucks
    try {
        const unsub = onSnapshot(collection(db, 'activeTrucks'), (snapshot) => {
            const trucks = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
            const liveEntries = trucks.map(t => ({
                icon: '📍', title: `Truck Active: ${t.driverId || t.id}`,
                detail: `Lat: ${t.lat?.toFixed(4) || '—'}, Lng: ${t.lng?.toFixed(4) || '—'}`,
                time: t.updatedAt?.toDate ? t.updatedAt.toDate() : new Date(),
                severity: 'info'
            }));

            // Combine with demo entries
            const all = [...liveEntries, ...DEMO_AUDIT_LOG].slice(0, 20);
            renderLiveAlertsList(container, all);
        });
        unsubscribeListeners.push(unsub);
    } catch (e) {
        // Fallback to demo data
        renderLiveAlertsList(container, DEMO_AUDIT_LOG);
    }
}

function renderLiveAlertsList(container, entries) {
    const styles = { critical: 'border-l-red-500 bg-red-500/5', warning: 'border-l-amber-500 bg-amber-500/5', success: 'border-l-emerald-500 bg-emerald-500/5', info: 'border-l-blue-500 bg-blue-500/5' };
    const textStyles = { critical: 'text-red-400', warning: 'text-amber-400', success: 'text-emerald-400', info: 'text-blue-400' };

    container.innerHTML = entries.map((e, i) => `
        <div class="border-l-4 ${styles[e.severity] || styles.info} rounded-r-xl p-3 transition-all duration-300 hover:translate-x-1" style="animation-delay:${i*50}ms">
            <div class="flex items-start gap-3">
                <span class="text-base mt-0.5 flex-shrink-0">${e.icon}</span>
                <div class="flex-1 min-w-0">
                    <p class="font-semibold ${textStyles[e.severity] || textStyles.info} text-xs">${e.title}</p>
                    <p class="text-slate-300 text-xs mt-1">${e.detail}</p>
                    <p class="text-slate-500 text-[10px] mt-1">${timeAgo(e.time)}</p>
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
        <div class="flex items-center gap-4 p-3 rounded-xl border border-emerald-500/15 bg-emerald-500/5 transition-all">
            <div class="w-9 h-9 rounded-lg bg-emerald-500/15 flex items-center justify-center flex-shrink-0">
                <span class="text-sm">📸</span>
            </div>
            <div class="flex-1 min-w-0">
                <p class="font-semibold text-white text-xs truncate">Booking: ${r.bookingId || '—'}</p>
                <p class="text-[10px] text-slate-400 mt-0.5">${uploadDate} · ${r.verified ? '✅ Verified' : '⏳ Pending'}</p>
            </div>
            ${r.url ? `<a href="${r.url}" target="_blank" class="px-2 py-1 rounded-md bg-blue-600/15 text-blue-400 text-[10px] font-semibold hover:bg-blue-600/30 transition-all">View</a>` : ''}
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
    L.tileLayer(DARK_TILE_URL, { attribution: DARK_TILE_ATTRIBUTION, maxZoom: 19 }).addTo(adminMap);

    const heatData = [];
    DEMO_SITES.forEach(site => {
        for (let i = 0; i < 10; i++) {
            heatData.push([site.lat + (Math.random() - 0.5) * 0.008, site.lng + (Math.random() - 0.5) * 0.008, Math.random() * 0.8 + 0.3]);
        }
    });

    if (window.L && L.heatLayer) {
        L.heatLayer(heatData, { radius: 30, blur: 20, maxZoom: 17, gradient: { 0.2: '#2563eb', 0.4: '#7c3aed', 0.6: '#f59e0b', 0.8: '#ef4444', 1.0: '#dc2626' } }).addTo(adminMap);
    }

    DEMO_SITES.forEach(site => {
        L.marker([site.lat, site.lng], {
            icon: L.divIcon({ className: '', html: `<div style="width:16px;height:16px;background:#3b82f6;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(59,130,246,0.6)"></div>`, iconSize: [16, 16], iconAnchor: [8, 8] })
        }).addTo(adminMap).bindPopup(`<div style="font-family:Inter,sans-serif;padding:4px"><strong style="font-size:13px">${site.name}</strong><br><span style="color:#666;font-size:12px">Road: ${site.road}</span><br><span style="color:#059669;font-size:12px;font-weight:600">Status: Active</span></div>`);
    });

    setTimeout(() => adminMap.invalidateSize(), 200);
}
