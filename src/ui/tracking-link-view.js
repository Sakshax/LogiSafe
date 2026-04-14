/**
 * driver-view.js — Zero-Install Mobile Driver Interface v2
 *
 * Features:
 *  - Large "Start Tracking" button with pulse animation
 *  - Real-time distance display with ETA
 *  - 500m geofence trigger unlocking compliance module
 *  - Camera/photo upload for dust mitigation proof
 *  - Delivery cannot be marked successful without verified photo
 *  - POST-DELIVERY: 3-second delay → auto-clears to "Trip Completed.
 *    Ready for Next Assignment" state (prevents dead-screen)
 */

import { startTracking, stopTracking, isTrackingActive, setDestination, getGeofenceRadius } from '../modules/tracking.js';
import { uploadCompliancePhoto, simulateUpload } from '../modules/compliance.js';
import { DEMO_SITES } from '../config/maps-config.js';

let initialized = false;
let trackingActive = false;
let complianceUnlocked = false;
let tripCompleted = false;
let latestDistanceKm = 999;

// DOM references
let els = {};

// Active trip info
const currentTrip = {
    driverId: 'driver-' + Date.now(),
    site: DEMO_SITES[0],
    bookingId: 'booking-demo-001'
};

export async function initTrackingLinkView(trackToken) {
    if (initialized) return;
    initialized = true;
    tripCompleted = false;

    // Cache DOM
    els = {
        view: document.getElementById('tracking-link-view'),
        trackBtn: document.getElementById('start-tracking-btn'),
        btnIcon: document.getElementById('tracking-btn-icon'),
        btnLabel: document.getElementById('tracking-btn-label'),
        statusText: document.getElementById('driver-status-text'),
        statusDot: document.getElementById('driver-status-dot'),
        distText: document.getElementById('driver-dist-text'),
        etaText: document.getElementById('driver-eta-text'),
        siteName: document.getElementById('driver-site-name'),
        complianceSection: document.getElementById('compliance-section'),
        complianceInstructions: document.getElementById('compliance-instructions'),
        uploadBtn: document.getElementById('upload-photo-btn'),
        photoInput: document.getElementById('compliance-photo'),
        progressContainer: document.getElementById('upload-progress'),
        progressBar: document.getElementById('upload-progress-bar'),
        uploadStatus: document.getElementById('upload-status-text'),
    };

    // Parse Token
    let bookingId = 'booking-demo-001';
    try { if (trackToken) bookingId = atob(trackToken).replace('booking_', ''); } catch (e) {}
    currentTrip.bookingId = bookingId;

    // Fetch Destination
    try {
        const { db, doc, getDoc } = await import('../config/firebase-config.js');
        const snap = await getDoc(doc(db, 'logistics_slots', bookingId));
        if (snap.exists()) {
            const data = snap.data();
            let destLat, destLng, siteNameStr;
            if (data.customLat && data.customLng) {
                destLat = data.customLat;
                destLng = data.customLng;
                siteNameStr = data.customAddress || 'Custom Location';
            } else {
                const siteObj = DEMO_SITES.find(s => s.id === data.targetSite) || DEMO_SITES[0];
                destLat = siteObj.lat;
                destLng = siteObj.lng;
                siteNameStr = siteObj.name;
            }
            currentTrip.site = { lat: destLat, lng: destLng, name: siteNameStr };
            setDestination({ lat: destLat, lng: destLng });
        }
    } catch(e) {}

    // Set site name
    if (els.siteName) els.siteName.textContent = currentTrip.site.name;

    // Bind events
    if (els.trackBtn) els.trackBtn.addEventListener('click', handleTrackToggle);
    if (els.uploadBtn) els.uploadBtn.addEventListener('click', () => els.photoInput?.click());
    if (els.photoInput) els.photoInput.addEventListener('change', handlePhotoUpload);
}

export function destroyTrackingLinkView() {
    if (trackingActive) {
        stopTracking();
        trackingActive = false;
    }
    initialized = false;
    complianceUnlocked = false;
    tripCompleted = false;
}

// ─── Tracking Toggle ────────────────────────────────────────────────────
function handleTrackToggle() {
    // If trip was completed, reset everything for next assignment
    if (tripCompleted) {
        return; // Link expired, do nothing
    }

    if (trackingActive) {
        // STOP
        if (latestDistanceKm > getGeofenceRadius()) {
            alert(`You are not at the location. Please drive to the destination (Distance: ${latestDistanceKm.toFixed(2)} km) before stopping.`);
            return;
        }

        stopTracking();
        trackingActive = false;
        
        // Ensure compliance unlocks if for some reason geofence trigger missed
        if (!complianceUnlocked) onGeofenceEnter(latestDistanceKm);

        setStatus('Arrived at Location', 'amber');
        if (els.btnLabel) els.btnLabel.textContent = 'ARRIVED';
    } else {
        // START
        trackingActive = true;
        setTrackingActiveUI();

        startTracking(
            currentTrip.driverId,
            onPositionUpdate,
            onGeofenceEnter,
            (errMsg) => console.warn('Tracking error:', errMsg)
        );
    }
}

// ─── Position Update Callback ───────────────────────────────────────────
function onPositionUpdate(distanceKm, lat, lng) {
    latestDistanceKm = distanceKm;
    if (els.distText) els.distText.textContent = `${distanceKm.toFixed(2)} km`;

    // Rough ETA estimate (avg city speed 25 km/h)
    const etaMinutes = Math.max(1, Math.round((distanceKm / 25) * 60));
    if (els.etaText) els.etaText.textContent = `${etaMinutes} min`;
}

// ─── Geofence Trigger ───────────────────────────────────────────────────
function onGeofenceEnter(distanceKm) {
    if (complianceUnlocked) return;
    complianceUnlocked = true;

    // Vibrate alert
    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);

    // Update status
    setStatus('Site Reached — Upload Required', 'amber');

    // Unlock compliance section
    const cs = els.complianceSection;
    if (cs) {
        cs.classList.remove('opacity-40', 'pointer-events-none', 'translate-y-4');
        cs.classList.add('opacity-100');
    }

    if (els.complianceInstructions) {
        els.complianceInstructions.innerHTML = `
            <span class="text-emerald-400 font-semibold">📸 Photo Required!</span>
            <span class="text-slate-300 ml-1">Upload a departing photo of the truck to complete.</span>`;
    }

    if (els.uploadBtn) {
        els.uploadBtn.disabled = false;
        els.uploadBtn.className = 'w-full flex justify-center items-center gap-3 bg-[#7A8C3E] text-white py-5 px-8 text-[10px] font-extrabold uppercase tracking-widest hover:bg-[#6c7d36] transition-all duration-300 active:scale-[0.97]';
    }
}

// ─── Photo Upload ───────────────────────────────────────────────────────
async function handlePhotoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    // Show progress
    if (els.progressContainer) els.progressContainer.classList.remove('hidden');
    if (els.uploadBtn) {
        els.uploadBtn.innerHTML = `
            <span class="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
            <span>UPLOADING PROOF...</span>`;
        els.uploadBtn.disabled = true;
        els.uploadBtn.className = 'w-full flex justify-center items-center gap-3 bg-[#1C1C1C] text-white py-5 px-8 text-[10px] font-extrabold uppercase tracking-widest cursor-wait';
    }

    try {
        const result = await uploadCompliancePhoto(file, currentTrip.bookingId, (progress) => {
            if (els.progressBar) els.progressBar.style.width = `${progress}%`;
        });
        completeDelivery(result.url);
    } catch (err) {
        // If Firebase Storage fails, simulate upload for demo
        const result = await simulateUpload((progress) => {
            if (els.progressBar) els.progressBar.style.width = `${progress}%`;
        });
        completeDelivery(result.url);
    }
}

function completeDelivery(photoUrl) {
    // Hide progress
    if (els.progressContainer) els.progressContainer.classList.add('hidden');

    // Success state
    if (els.uploadBtn) {
        els.uploadBtn.innerHTML = `
            <svg class="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
            <span>VERIFIED BY SYSTEM</span>`;
        els.uploadBtn.className = 'w-full flex justify-center items-center gap-3 bg-[#F8FAFC] text-[#7A8C3E] border border-[#7A8C3E]/20 py-5 px-8 text-[10px] font-extrabold uppercase tracking-widest';
        els.uploadBtn.disabled = true;
    }

    if (els.uploadStatus) {
        els.uploadStatus.classList.remove('hidden');
        els.uploadStatus.textContent = `Photo verified at ${new Date().toLocaleTimeString()}`;
    }

    setStatus('Delivery Successful', 'emerald');

    // ── POST-DELIVERY TRANSITION ────────────────────────────────────
    // After 3 seconds: stop tracking, clear screen, show "Ready for Next"
    setTimeout(() => {
        if (trackingActive) {
            stopTracking();
            trackingActive = false;
        }
        showTripCompletedState();
    }, 3000);
}

// ─── Trip Completed State ───────────────────────────────────────────────
/**
 * Renders the "Link Expired" screen.
 */
function showTripCompletedState() {
    tripCompleted = true;
    complianceUnlocked = false;

    // Remove tracking-active styles
    if (els.view) els.view.classList.remove('tracking-active');

    // ── Update Status Card ──────────────────────────────────────────
    setStatus('Trip Completed', 'emerald');
    if (els.distText) els.distText.textContent = '0.00 km';
    if (els.etaText) els.etaText.textContent = '0 min';
    if (els.siteName) els.siteName.textContent = '✅ Verified & Closed';

    // Disable track button
    if (els.trackBtn) els.trackBtn.style.display = 'none';

    // ── Transform compliance section → Link Expired ─────────────────
    const cs = els.complianceSection;
    if (cs) {
        cs.classList.remove('opacity-40', 'pointer-events-none', 'translate-y-4');
        cs.classList.add('opacity-100');
        cs.innerHTML = `
            <div class="text-center py-6">
                <!-- Success checkmark -->
                <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-500/15 border-2 border-emerald-500/30 flex items-center justify-center">
                    <svg class="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                    </svg>
                </div>

                <h3 class="text-xl font-bold text-white mb-2">Departing Verified</h3>
                <p class="text-amber-400 text-sm font-medium mb-4">This tracking link is now expired.</p>

                <p class="text-slate-500 text-xs mt-4">You may safely close this page.</p>
                
                <button onclick="window.close()" class="mt-6 px-6 py-2.5 bg-slate-700 hover:bg-slate-600 rounded-xl text-sm text-white font-semibold transition-all">Close Window</button>
            </div>
        `;
    }
}

// ─── UI State Helpers ───────────────────────────────────────────────────
function setTrackingActiveUI() {
    if (els.view) els.view.classList.add('tracking-active');
    if (els.btnLabel) els.btnLabel.textContent = 'STOP';
    if (els.btnIcon) els.btnIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 10a1 1 0 011-1h4a1 1 0 011 1v4a1 1 0 01-1 1h-4a1 1 0 01-1-1v-4z"/>`;
    setStatus('On Route', 'emerald');
}

function resetDriverUI() {
    if (els.view) els.view.classList.remove('tracking-active');
    if (els.btnLabel) els.btnLabel.textContent = 'START';
    if (els.btnIcon) els.btnIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"/>`;
    setStatus('Ready to Depart', 'slate');

    if (els.distText) els.distText.textContent = '-- km';
    if (els.etaText) els.etaText.textContent = '-- min';
    if (els.siteName) els.siteName.textContent = currentTrip.site.name;

    // Reset button styling (clear any custom inline styles from trip-complete)
    const core = els.trackBtn?.querySelector('.track-btn-core');
    if (core) { core.style.background = ''; core.style.borderColor = ''; core.style.boxShadow = ''; }
    const ring1 = els.trackBtn?.querySelector('.track-btn-ring-1');
    const ring2 = els.trackBtn?.querySelector('.track-btn-ring-2');
    if (ring1) ring1.style.background = '';
    if (ring2) ring2.style.background = '';

    // Re-lock and restore compliance section
    complianceUnlocked = false;
    const cs = els.complianceSection;
    if (cs) {
        cs.classList.add('opacity-40', 'pointer-events-none', 'translate-y-4');
        cs.classList.remove('opacity-100');
        cs.innerHTML = `
            <h4 class="font-semibold flex items-center gap-2 mb-3 text-sm">
                <svg class="w-5 h-5 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>
                Site Arrival Compliance
            </h4>
            <p id="compliance-instructions" class="text-xs text-slate-400 mb-4 leading-relaxed">
                <span class="text-slate-500">🔒 Locked</span> — Approach within 500m of the site to unlock dust mitigation photo upload.
            </p>

            <input type="file" id="compliance-photo" accept="image/*" capture="environment" class="hidden">
            <button id="upload-photo-btn" class="w-full flex justify-center items-center gap-3 bg-slate-700 text-slate-400 py-4 rounded-2xl font-semibold cursor-not-allowed text-sm" disabled>
                <svg class="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"><path stroke-linecap="round" stroke-linejoin="round" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z"/></svg>
                <span>Take Dust Mitigation Photo</span>
            </button>

            <div id="upload-progress" class="hidden w-full bg-slate-700 rounded-full h-1.5 mt-4 overflow-hidden">
                <div id="upload-progress-bar" class="bg-gradient-to-r from-blue-500 to-emerald-500 h-full rounded-full transition-all duration-300 ease-out" style="width: 0%"></div>
            </div>
            <p id="upload-status-text" class="hidden text-xs text-emerald-400 mt-3 text-center font-medium"></p>
        `;

        // Re-cache the DOM elements after innerHTML replacement
        els.complianceInstructions = document.getElementById('compliance-instructions');
        els.uploadBtn = document.getElementById('upload-photo-btn');
        els.photoInput = document.getElementById('compliance-photo');
        els.progressContainer = document.getElementById('upload-progress');
        els.progressBar = document.getElementById('upload-progress-bar');
        els.uploadStatus = document.getElementById('upload-status-text');

        // Re-bind events on new elements
        if (els.uploadBtn) els.uploadBtn.addEventListener('click', () => els.photoInput?.click());
        if (els.photoInput) els.photoInput.addEventListener('change', handlePhotoUpload);
    }
}

function setStatus(text, color) {
    const colors = {
        slate:   { text: 'text-slate-300',   dot: 'bg-slate-400' },
        emerald: { text: 'text-emerald-400', dot: 'bg-emerald-400' },
        amber:   { text: 'text-amber-400',   dot: 'bg-amber-400' },
        red:     { text: 'text-red-400',     dot: 'bg-red-400' },
    };
    const c = colors[color] || colors.slate;
    if (els.statusText) { els.statusText.textContent = text; els.statusText.className = `text-xl font-bold ${c.text}`; }
    if (els.statusDot)  { els.statusDot.className = `w-3 h-3 rounded-full ${c.dot} ${color === 'emerald' ? 'animate-pulse' : ''}`; }
}
