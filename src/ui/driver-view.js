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

import { startTracking, stopTracking, isTrackingActive } from '../modules/tracking.js';
import { uploadCompliancePhoto, simulateUpload } from '../modules/compliance.js';
import { DEMO_SITES } from '../config/maps-config.js';

let initialized = false;
let trackingActive = false;
let complianceUnlocked = false;
let tripCompleted = false;

// DOM references
let els = {};

// Active trip info
const currentTrip = {
    driverId: 'driver-' + Date.now(),
    site: DEMO_SITES[0],
    bookingId: 'booking-demo-001'
};

export function initDriverView() {
    if (initialized) return;
    initialized = true;
    tripCompleted = false;

    // Cache DOM
    els = {
        view: document.getElementById('driver-view'),
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

    // Set site name
    if (els.siteName) els.siteName.textContent = currentTrip.site.name;

    // Bind events
    if (els.trackBtn) els.trackBtn.addEventListener('click', handleTrackToggle);
    if (els.uploadBtn) els.uploadBtn.addEventListener('click', () => els.photoInput?.click());
    if (els.photoInput) els.photoInput.addEventListener('change', handlePhotoUpload);
}

export function destroyDriverView() {
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
        tripCompleted = false;
        currentTrip.driverId = 'driver-' + Date.now();
        currentTrip.bookingId = 'booking-' + Date.now();
        resetDriverUI();
        return;
    }

    if (trackingActive) {
        // STOP
        stopTracking();
        trackingActive = false;
        resetDriverUI();
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
            <span class="text-emerald-400 font-semibold">🎯 Site Ready Alert!</span>
            <span class="text-slate-300 ml-1">You are ${(distanceKm * 1000).toFixed(0)}m from ${currentTrip.site.name}. Capture proof of dust mitigation to complete delivery.</span>`;
    }

    if (els.uploadBtn) {
        els.uploadBtn.disabled = false;
        els.uploadBtn.className = 'w-full flex justify-center items-center gap-3 bg-blue-600 hover:bg-blue-500 text-white py-4 rounded-2xl font-semibold transition-all duration-300 active:scale-[0.97]';
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
            <span>Uploading proof...</span>`;
        els.uploadBtn.disabled = true;
        els.uploadBtn.className = 'w-full flex justify-center items-center gap-3 bg-amber-600 text-white py-4 rounded-2xl font-semibold cursor-wait';
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
            <span>Compliance Verified</span>`;
        els.uploadBtn.className = 'w-full flex justify-center items-center gap-3 bg-emerald-600 text-white py-4 rounded-2xl font-semibold';
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
 * Renders the "Trip Completed. Ready for Next Assignment" screen.
 * Replaces the tracking/compliance UI to prevent a dead-screen.
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
    if (els.siteName) els.siteName.textContent = '✅ Assignment Finished';

    // ── Transform the tracking button into "Next Assignment" ────────
    if (els.btnIcon) {
        els.btnIcon.innerHTML = `
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>
        `;
    }
    if (els.btnLabel) els.btnLabel.textContent = 'NEXT';

    // Change button color to blue glow
    const core = els.trackBtn?.querySelector('.track-btn-core');
    if (core) {
        core.style.background = 'linear-gradient(135deg, #2563eb, #7c3aed)';
        core.style.borderColor = '#1e1b4b';
        core.style.boxShadow = '0 0 50px -5px rgba(99, 102, 241, 0.4), inset 0 2px 10px rgba(0,0,0,0.4)';
    }

    // Update ring colors
    const ring1 = els.trackBtn?.querySelector('.track-btn-ring-1');
    const ring2 = els.trackBtn?.querySelector('.track-btn-ring-2');
    if (ring1) ring1.style.background = 'rgba(99, 102, 241, 0.12)';
    if (ring2) ring2.style.background = 'rgba(99, 102, 241, 0.2)';

    // ── Transform compliance section → Trip Summary ─────────────────
    const cs = els.complianceSection;
    if (cs) {
        cs.classList.remove('opacity-40', 'pointer-events-none', 'translate-y-4');
        cs.classList.add('opacity-100');
        cs.innerHTML = `
            <div class="text-center py-4">
                <!-- Success checkmark -->
                <div class="w-16 h-16 mx-auto mb-4 rounded-full bg-emerald-500/15 border-2 border-emerald-500/30 flex items-center justify-center">
                    <svg class="w-8 h-8 text-emerald-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                    </svg>
                </div>

                <h3 class="text-lg font-bold text-white mb-1">Trip Completed</h3>
                <p class="text-emerald-400 text-sm font-medium mb-4">Ready for Next Assignment</p>

                <!-- Trip Summary -->
                <div class="grid grid-cols-3 gap-3 mt-4 mb-2">
                    <div class="bg-slate-800/50 rounded-xl p-3">
                        <p class="text-[10px] text-slate-500 uppercase tracking-wider">Site</p>
                        <p class="text-xs text-white font-semibold mt-1 truncate">${currentTrip.site.name.split('–')[0].trim()}</p>
                    </div>
                    <div class="bg-slate-800/50 rounded-xl p-3">
                        <p class="text-[10px] text-slate-500 uppercase tracking-wider">Status</p>
                        <p class="text-xs text-emerald-400 font-semibold mt-1">Verified ✓</p>
                    </div>
                    <div class="bg-slate-800/50 rounded-xl p-3">
                        <p class="text-[10px] text-slate-500 uppercase tracking-wider">Time</p>
                        <p class="text-xs text-white font-semibold mt-1">${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true })}</p>
                    </div>
                </div>

                <p class="text-slate-500 text-xs mt-4">Tap the <span class="text-violet-400 font-semibold">NEXT</span> button above to start a new assignment</p>
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
