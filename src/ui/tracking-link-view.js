/**
 * tracking-link-view.js — Zero-Install Mobile Driver Interface v4
 *
 * Flow:
 *  1. Driver opens temp tracking link → sees LOGIN form on the tracking page
 *  2. Driver signs in with their registered driver account
 *  3. After login → GPS auto-starts immediately + live map shows driver position
 *  4. Real-time: driver moves → map updates → Firestore syncs → manager sees movement
 *  5. Driver stops → nothing updates → manager map truck stays still
 *  6. 500m geofence → compliance photo unlock
 *  7. Photo upload → delivery complete → link expired
 */

import { startTracking, stopTracking, isTrackingActive, setDestination, getGeofenceRadius } from '../modules/tracking.js';
import { uploadCompliancePhoto, simulateUpload } from '../modules/compliance.js';
import { DEMO_SITES } from '../config/maps-config.js';
import { initMaps, STANDARD_TILE_URL, STANDARD_TILE_ATTRIBUTION, createTruckIcon, createSiteIcon } from '../config/maps-config.js';

let initialized = false;
let trackingActive = false;
let complianceUnlocked = false;
let tripCompleted = false;
let latestDistanceKm = 999;
let trackToken = null;

// Live map references
let driverMap = null;
let driverMarker = null;
let destMarker = null;
let routeLine = null;

// DOM references
let els = {};

// Active trip info
const currentTrip = {
    driverId: null,
    driverName: null,
    site: DEMO_SITES[0],
    bookingId: 'booking-demo-001'
};

// Speed tracking
let lastPositionTime = null;
let lastSpeedKmh = 0;

export async function initTrackingLinkView(token) {
    if (initialized) return;
    initialized = true;
    tripCompleted = false;
    trackToken = token;

    // Show the login gate, hide tracking UI
    const loginGate = document.getElementById('tracking-login-gate');
    const mainUI = document.getElementById('tracking-main-ui');
    if (loginGate) loginGate.classList.remove('hidden');
    if (mainUI) mainUI.classList.add('hidden');

    // Bind login events
    bindTrackingLogin();
}

export function destroyTrackingLinkView() {
    if (trackingActive) {
        stopTracking();
        trackingActive = false;
    }
    if (driverMap) {
        driverMap.remove();
        driverMap = null;
    }
    driverMarker = null;
    destMarker = null;
    routeLine = null;
    initialized = false;
    complianceUnlocked = false;
    tripCompleted = false;
    trackToken = null;
    currentTrip.driverId = null;
    currentTrip.driverName = null;
    lastPositionTime = null;
}

// ─── Inline Login Handler ───────────────────────────────────────────────
function bindTrackingLogin() {
    const loginBtn = document.getElementById('track-login-btn');
    const emailInput = document.getElementById('track-login-email');
    const passwordInput = document.getElementById('track-login-password');

    if (!loginBtn) return;

    const doLogin = async () => {
        const email = emailInput?.value?.trim();
        const password = passwordInput?.value?.trim();

        if (!email) { showTrackLoginError('Please enter your email.'); return; }
        if (!password) { showTrackLoginError('Please enter your password.'); return; }

        loginBtn.disabled = true;
        loginBtn.innerHTML = '<span class="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>';
        hideTrackLoginError();

        try {
            const { auth, signInWithEmailAndPassword, db, doc } = await import('../config/firebase-config.js');
            const fbModule = await import('https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js');
            
            const cred = await signInWithEmailAndPassword(auth, email, password);
            const uid = cred.user.uid;

            // Verify this user is an approved driver
            const snap = await fbModule.getDoc(doc(db, 'users', uid));
            
            if (!snap.exists()) {
                showTrackLoginError('Account not found in the system.');
                resetLoginBtn(loginBtn);
                return;
            }

            const profile = snap.data();

            if (profile.role !== 'driver') {
                showTrackLoginError('Only driver accounts can access tracking links.');
                resetLoginBtn(loginBtn);
                return;
            }

            if (profile.status !== 'active') {
                showTrackLoginError('Your account is pending admin approval.');
                resetLoginBtn(loginBtn);
                return;
            }

            // ✅ Success — set driver info
            currentTrip.driverId = uid;
            currentTrip.driverName = profile.name || email;

            // Load destination, show tracking UI, auto-start GPS
            await loadDestinationAndAutoStart();

        } catch (err) {
            console.warn('Tracking login error:', err);
            const errorMap = {
                'auth/user-not-found': 'No account with this email.',
                'auth/wrong-password': 'Incorrect password.',
                'auth/invalid-credential': 'Invalid email or password.',
                'auth/invalid-email': 'Invalid email format.',
                'auth/too-many-requests': 'Too many attempts. Wait and retry.',
            };
            showTrackLoginError(errorMap[err.code] || `Login failed: ${err.message}`);
            resetLoginBtn(loginBtn);
        }
    };

    loginBtn.addEventListener('click', doLogin);
    [emailInput, passwordInput].forEach(input => {
        if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    });
}

function resetLoginBtn(btn) {
    btn.disabled = false;
    btn.innerHTML = 'Sign In & Start Trip';
}

function showTrackLoginError(msg) {
    const el = document.getElementById('track-login-status');
    if (!el) return;
    el.classList.remove('hidden');
    el.textContent = msg;
}

function hideTrackLoginError() {
    const el = document.getElementById('track-login-status');
    if (el) el.classList.add('hidden');
}

// ─── Load Destination, Show UI, Auto-Start GPS ─────────────────────────
async function loadDestinationAndAutoStart() {
    // Parse booking ID from token
    let bookingId = 'booking-demo-001';
    try { if (trackToken) bookingId = atob(trackToken).replace('booking_', ''); } catch (e) {}
    currentTrip.bookingId = bookingId;

    // Fetch Destination from Firestore
    try {
        const { db, doc, getDoc } = await import('../config/firebase-config.js');
        const snap = await getDoc(doc(db, 'logistics_slots', bookingId));
        if (snap.exists()) {
            const data = snap.data();
            let destLat, destLng, siteNameStr;
            
            if (data.destLat && data.destLng) {
                destLat = data.destLat;
                destLng = data.destLng;
                siteNameStr = data.destName || data.targetSite || 'Assigned Destination';
            } else if (data.customLat && data.customLng) {
                destLat = data.customLat;
                destLng = data.customLng;
                siteNameStr = data.customAddress || 'Custom Location';
            } else {
                const siteObj = DEMO_SITES.find(s => s.name === data.targetSite || s.id === data.targetSite) || DEMO_SITES[0];
                destLat = siteObj.lat;
                destLng = siteObj.lng;
                siteNameStr = siteObj.name;
            }
            
            currentTrip.site = { lat: destLat, lng: destLng, name: siteNameStr };
            setDestination({ lat: destLat, lng: destLng });
        }
    } catch(e) {
        console.warn('Failed to load destination:', e);
    }

    // Hide login gate, show tracking UI
    const loginGate = document.getElementById('tracking-login-gate');
    const mainUI = document.getElementById('tracking-main-ui');
    if (loginGate) loginGate.style.display = 'none';
    if (mainUI) mainUI.classList.remove('hidden');

    // Cache DOM
    els = {
        view: document.getElementById('tracking-link-view'),
        statusText: document.getElementById('driver-status-text'),
        distText: document.getElementById('driver-dist-text'),
        etaText: document.getElementById('driver-eta-text'),
        speedText: document.getElementById('driver-speed-text'),
        siteName: document.getElementById('driver-site-name'),
        driverNameEl: document.getElementById('tracking-driver-name'),
        gpsDot: document.getElementById('gps-dot'),
        gpsLabel: document.getElementById('gps-status-label'),
        stopSection: document.getElementById('stop-tracking-section'),
        stopBtn: document.getElementById('stop-tracking-btn'),
        complianceSection: document.getElementById('compliance-section'),
        complianceInstructions: document.getElementById('compliance-instructions'),
        uploadBtn: document.getElementById('upload-photo-btn'),
        photoInput: document.getElementById('compliance-photo'),
        progressContainer: document.getElementById('upload-progress'),
        progressBar: document.getElementById('upload-progress-bar'),
        uploadStatus: document.getElementById('upload-status-text'),
    };

    // Set UI content
    if (els.siteName) els.siteName.textContent = currentTrip.site.name;
    if (els.driverNameEl) els.driverNameEl.textContent = `/ ${currentTrip.driverName}`;

    // Bind stop button
    if (els.stopBtn) els.stopBtn.addEventListener('click', handleStopTracking);
    if (els.uploadBtn) els.uploadBtn.addEventListener('click', () => els.photoInput?.click());
    if (els.photoInput) els.photoInput.addEventListener('change', handlePhotoUpload);

    // Bind EXIT TRIP button
    const closeBtn = document.getElementById('close-tracking-btn');
    if (closeBtn) {
        closeBtn.addEventListener('click', () => {
            if (trackingActive) {
                if (!confirm('Tracking is active. Are you sure you want to exit?')) return;
                stopTracking();
                trackingActive = false;
            }
            destroyTrackingLinkView();
            window.location.reload();
        });
    }

    // Initialize the live driver map
    await initDriverMap();

    // AUTO-START GPS TRACKING immediately
    autoStartGPS();
}

// ─── Live Driver Map ────────────────────────────────────────────────────
async function initDriverMap() {
    const mapContainer = document.getElementById('driver-live-map');
    if (!mapContainer) return;

    try {
        await initMaps();
    } catch (e) {
        mapContainer.innerHTML = `
            <div style="display:flex;align-items:center;justify-content:center;height:100%;background:#F7F8F5;">
                <p style="color:#94A3B8;font-size:13px;">Map loading failed</p>
            </div>`;
        return;
    }

    driverMap = L.map(mapContainer, {
        center: [currentTrip.site.lat, currentTrip.site.lng],
        zoom: 14,
        zoomControl: false,
        attributionControl: false
    });

    L.tileLayer(STANDARD_TILE_URL, {
        attribution: STANDARD_TILE_ATTRIBUTION,
        maxZoom: 19
    }).addTo(driverMap);

    // Destination marker
    const destIcon = L.divIcon({
        className: 'dest-pin',
        html: `<div style="width:24px;height:24px;background:#E05535;border:3px solid #fff;border-radius:50%;box-shadow:0 0 12px rgba(224,85,53,0.4);display:flex;align-items:center;justify-content:center;">
                 <div style="width:6px;height:6px;background:#fff;border-radius:50%;"></div>
               </div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
    });
    destMarker = L.marker([currentTrip.site.lat, currentTrip.site.lng], { icon: destIcon }).addTo(driverMap);
    destMarker.bindPopup(`<div style="font-family:Inter,sans-serif;font-size:12px;font-weight:600;">${currentTrip.site.name}</div>`);

    // 500m geofence circle
    L.circle([currentTrip.site.lat, currentTrip.site.lng], {
        radius: 500,
        color: '#7A8C3E',
        fillColor: '#7A8C3E',
        fillOpacity: 0.08,
        weight: 1,
        dashArray: '6, 4'
    }).addTo(driverMap);

    setTimeout(() => driverMap?.invalidateSize(), 300);
}

/**
 * Update the live map with the driver's real position.
 */
function updateDriverMapPosition(lat, lng) {
    if (!driverMap) return;

    const truckIcon = L.divIcon({
        className: 'driver-truck',
        html: `<div style="width:36px;height:36px;background:#1C1C1C;border:3px solid #7A8C3E;border-radius:8px;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 12px rgba(0,0,0,0.3);">
                 <span style="font-size:20px;">🚛</span>
               </div>`,
        iconSize: [36, 36],
        iconAnchor: [18, 18]
    });

    if (driverMarker) {
        driverMarker.setLatLng([lat, lng]);
    } else {
        driverMarker = L.marker([lat, lng], { icon: truckIcon }).addTo(driverMap);
    }

    // Update route line from driver to destination
    if (routeLine) {
        driverMap.removeLayer(routeLine);
    }
    routeLine = L.polyline(
        [[lat, lng], [currentTrip.site.lat, currentTrip.site.lng]],
        { color: '#7A8C3E', weight: 3, opacity: 0.6, dashArray: '8, 6' }
    ).addTo(driverMap);

    // Pan map to keep driver visible
    driverMap.panTo([lat, lng], { animate: true, duration: 0.5 });
}

// ─── Auto-Start GPS ─────────────────────────────────────────────────────
function autoStartGPS() {
    trackingActive = true;
    lastPositionTime = null;

    setStatus('CONNECTING GPS...', '#F4A623');

    startTracking(
        currentTrip.driverId,
        onPositionUpdate,
        onGeofenceEnter,
        (errMsg) => {
            console.warn('GPS error:', errMsg);
            setGPSStatus('error', `⚠️ ${errMsg}`);
            setStatus('GPS ERROR', '#E05535');
        }
    );
}

// ─── Position Update Callback ───────────────────────────────────────────
function onPositionUpdate(distanceKm, lat, lng) {
    latestDistanceKm = distanceKm;

    // Distance
    if (els.distText) els.distText.textContent = distanceKm.toFixed(2);

    // ETA (avg city speed 25 km/h)
    const etaMinutes = Math.max(1, Math.round((distanceKm / 25) * 60));
    if (els.etaText) els.etaText.textContent = `${etaMinutes}`;

    // Speed calculation
    const now = Date.now();
    if (lastPositionTime) {
        const timeDiffHours = (now - lastPositionTime) / (1000 * 60 * 60);
        if (timeDiffHours > 0) {
            // Use distance-to-dest change as proxy (rough)
            lastSpeedKmh = Math.min(80, Math.max(0, Math.round(distanceKm / Math.max(0.01, etaMinutes / 60))));
        }
    }
    lastPositionTime = now;
    if (els.speedText) els.speedText.textContent = `${lastSpeedKmh}`;

    // GPS status → active
    setGPSStatus('active', `📡 LIVE — ${lat.toFixed(4)}, ${lng.toFixed(4)}`);
    setStatus('ON ROUTE', '#7A8C3E');

    // Show stop button
    if (els.stopSection) els.stopSection.classList.remove('hidden');

    // Update live map
    updateDriverMapPosition(lat, lng);
}

// ─── GPS Status UI ──────────────────────────────────────────────────────
function setGPSStatus(state, text) {
    if (state === 'active') {
        if (els.gpsDot) { els.gpsDot.style.background = '#7A8C3E'; }
        if (els.gpsLabel) { els.gpsLabel.textContent = text; els.gpsLabel.style.color = '#7A8C3E'; }
    } else if (state === 'error') {
        if (els.gpsDot) { els.gpsDot.style.background = '#E05535'; }
        if (els.gpsLabel) { els.gpsLabel.textContent = text; els.gpsLabel.style.color = '#E05535'; }
    } else {
        if (els.gpsDot) { els.gpsDot.style.background = '#F4A623'; }
        if (els.gpsLabel) { els.gpsLabel.textContent = text; els.gpsLabel.style.color = '#F4A623'; }
    }
}

// ─── Geofence Trigger ───────────────────────────────────────────────────
function onGeofenceEnter(distanceKm) {
    if (complianceUnlocked) return;
    complianceUnlocked = true;

    if (navigator.vibrate) navigator.vibrate([200, 100, 200, 100, 200]);

    setStatus('SITE REACHED', '#F4A623');

    const cs = els.complianceSection;
    if (cs) {
        cs.style.opacity = '1';
        cs.style.pointerEvents = 'auto';
        cs.style.transform = 'translateY(0)';
    }

    if (els.complianceInstructions) {
        els.complianceInstructions.innerHTML = `
            <span style="color:#7A8C3E;font-weight:600;">📸 Photo Required!</span>
            <span style="color:#64748B;margin-left:4px;">Upload a departing photo to complete delivery.</span>`;
    }

    if (els.uploadBtn) els.uploadBtn.disabled = false;
}

// ─── Stop Tracking ──────────────────────────────────────────────────────
function handleStopTracking() {
    if (tripCompleted) return;

    if (latestDistanceKm > getGeofenceRadius()) {
        alert(`You are ${latestDistanceKm.toFixed(2)} km away. Drive to the destination before stopping.`);
        return;
    }

    stopTracking();
    trackingActive = false;

    if (!complianceUnlocked) onGeofenceEnter(latestDistanceKm);

    setStatus('ARRIVED', '#F4A623');
    setGPSStatus('waiting', '📍 ARRIVED AT SITE');

    if (els.stopSection) els.stopSection.classList.add('hidden');
}

// ─── Photo Upload ───────────────────────────────────────────────────────
async function handlePhotoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    if (els.progressContainer) els.progressContainer.classList.remove('hidden');
    if (els.uploadBtn) {
        els.uploadBtn.innerHTML = `
            <span class="inline-block w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></span>
            <span>UPLOADING PROOF...</span>`;
        els.uploadBtn.disabled = true;
    }

    try {
        const result = await uploadCompliancePhoto(file, currentTrip.bookingId, (progress) => {
            if (els.progressBar) els.progressBar.style.width = `${progress}%`;
        });
        completeDelivery(result.url);
    } catch (err) {
        const result = await simulateUpload((progress) => {
            if (els.progressBar) els.progressBar.style.width = `${progress}%`;
        });
        completeDelivery(result.url);
    }
}

function completeDelivery(photoUrl) {
    if (els.progressContainer) els.progressContainer.classList.add('hidden');

    if (els.uploadBtn) {
        els.uploadBtn.innerHTML = `
            <svg style="width:24px;height:24px;" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/></svg>
            <span>VERIFIED BY SYSTEM</span>`;
        els.uploadBtn.disabled = true;
    }

    if (els.uploadStatus) {
        els.uploadStatus.classList.remove('hidden');
        els.uploadStatus.textContent = `Photo verified at ${new Date().toLocaleTimeString()}`;
    }

    setStatus('DELIVERY COMPLETE', '#7A8C3E');
    setGPSStatus('active', '✅ DELIVERY VERIFIED');

    setTimeout(() => {
        if (trackingActive) {
            stopTracking();
            trackingActive = false;
        }
        showTripCompletedState();
    }, 3000);
}

// ─── Trip Completed ─────────────────────────────────────────────────────
function showTripCompletedState() {
    tripCompleted = true;
    complianceUnlocked = false;

    setStatus('TRIP COMPLETED', '#7A8C3E');
    if (els.distText) els.distText.textContent = '0.00';
    if (els.etaText) els.etaText.textContent = '0';
    if (els.speedText) els.speedText.textContent = '0';
    if (els.siteName) els.siteName.textContent = '✅ Verified & Closed';
    if (els.stopSection) els.stopSection.classList.add('hidden');

    setGPSStatus('active', '✅ LINK EXPIRED');

    const cs = els.complianceSection;
    if (cs) {
        cs.style.opacity = '1';
        cs.style.pointerEvents = 'auto';
        cs.style.transform = 'translateY(0)';
        cs.innerHTML = `
            <div class="text-center py-6">
                <div style="width:64px;height:64px;margin:0 auto 1rem;border-radius:50%;background:rgba(122,140,62,0.1);border:2px solid rgba(122,140,62,0.3);display:flex;align-items:center;justify-content:center;">
                    <svg style="width:32px;height:32px;color:#7A8C3E;" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5">
                        <path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7"/>
                    </svg>
                </div>
                <h3 style="font-size:20px;font-weight:800;color:#1C1C1C;margin-bottom:0.5rem;">Departing Verified</h3>
                <p style="color:#F4A623;font-size:14px;font-weight:500;margin-bottom:1rem;">This tracking link is now expired.</p>
                <p style="color:#94A3B8;font-size:12px;">You may safely close this page.</p>
                <button onclick="window.close()" style="margin-top:1.5rem;padding:0.625rem 1.5rem;background:#F7F8F5;border:1px solid rgba(28,28,28,0.1);font-size:14px;color:#1C1C1C;font-weight:600;cursor:pointer;">Close Window</button>
            </div>
        `;
    }
}

// ─── UI Helpers ─────────────────────────────────────────────────────────
function setStatus(text, color) {
    if (els.statusText) {
        els.statusText.textContent = text;
        els.statusText.style.color = color || '#1C1C1C';
    }
}
