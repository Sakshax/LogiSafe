/**
 * maps-config.js — Map Configuration using Leaflet.js + OpenStreetMap
 *
 * 100% FREE — No API key required. No billing. No limits.
 * Uses Leaflet.js (open-source) with OpenStreetMap tiles.
 */

let mapsReady = false;
let mapsPromise = null;

/**
 * Dynamically load Leaflet.js CSS + JS from CDN.
 * @returns {Promise<void>}
 */
export function initMaps() {
    if (mapsReady) return Promise.resolve();
    if (mapsPromise) return mapsPromise;

    mapsPromise = new Promise((resolve, reject) => {
        // Already loaded
        if (window.L) {
            mapsReady = true;
            resolve();
            return;
        }

        // Load Leaflet CSS
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
        css.integrity = 'sha256-p4NxAoJBhIIN+hmNHrzRCf9tD/miZyoHS5obTRR9BMY=';
        css.crossOrigin = '';
        document.head.appendChild(css);

        // Load Leaflet JS
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
        script.integrity = 'sha256-20nQCchB9co0qIjJZRGuk2/Z9VM+kNiyxNV1lvTlZBo=';
        script.crossOrigin = '';

        script.onload = () => {
            // Load Leaflet.heat plugin for heatmaps
            const heatScript = document.createElement('script');
            heatScript.src = 'https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js';
            heatScript.onload = () => {
                mapsReady = true;
                resolve();
            };
            heatScript.onerror = () => {
                // Heatmap plugin is optional — maps still work without it
                mapsReady = true;
                resolve();
            };
            document.head.appendChild(heatScript);
        };

        script.onerror = () => reject(new Error('Failed to load Leaflet.js'));
        document.head.appendChild(script);
    });

    return mapsPromise;
}

/**
 * Dark-themed tile layer URL (free, no key needed)
 */
export const DARK_TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
export const DARK_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/">CARTO</a>';

/**
 * Standard tile layer URL (free, no key needed)
 */
export const STANDARD_TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const STANDARD_TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

/**
 * Mira-Bhayandar center coordinates
 */
export const MIRA_BHAYANDAR_CENTER = { lat: 19.2952, lng: 72.8544 };

/**
 * Demo construction site locations in Mira-Bhayandar
 */
export const DEMO_SITES = [
    { id: 'site-alpha', name: 'Site Alpha – Mira Road East',    lat: 19.2813, lng: 72.8808, road: 'Kashimira Rd' },
    { id: 'site-beta',  name: 'Site Beta – Bhayandar West',     lat: 19.3120, lng: 72.8380, road: 'Station Rd' },
    { id: 'site-gamma', name: 'Site Gamma – Kashimira Junction', lat: 19.2650, lng: 72.8600, road: 'Ghodbunder Rd' },
    { id: 'site-delta', name: 'Site Delta – Beverly Park',      lat: 19.2900, lng: 72.8700, road: 'SV Rd' },
    { id: 'site-omega', name: 'Site Omega – Bhayandar East',    lat: 19.3050, lng: 72.8620, road: 'Navghar Rd' },
];

/**
 * Create a styled site marker icon
 */
export function createSiteIcon() {
    if (!window.L) return null;
    return L.divIcon({
        className: 'custom-site-marker',
        html: `<div style="width:20px;height:20px;background:#7A8C3E;border:3px solid #fff;border-radius:50%;box-shadow:0 0 10px rgba(122,140,62,0.3)"></div>`,
        iconSize: [20, 20],
        iconAnchor: [10, 10],
        popupAnchor: [0, -12]
    });
}

export function createTruckIcon() {
    if (!window.L) return null;
    return L.divIcon({
        className: 'custom-truck-marker',
        html: `<div style="width:32px;height:32px;background:#1C1C1C;border:2px solid #7A8C3E;border-radius:6px;display:flex;items-center;justify-content:center;box-shadow:0 4px 8px rgba(0,0,0,0.2)">
                 <span style="font-size:18px">🚛</span>
               </div>`,
        iconSize: [32, 32],
        iconAnchor: [16, 16],
        popupAnchor: [0, -18]
    });
}
