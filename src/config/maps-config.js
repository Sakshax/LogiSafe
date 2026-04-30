/**
 * maps-config.js — Map Configuration using Leaflet.js + OpenStreetMap
 *
 * 100% FREE — No API key required. No billing. No limits.
 * Uses Leaflet.js (open-source) with OpenStreetMap tiles.
 * Includes Leaflet Routing Machine for road-following routes via OSRM.
 */

let mapsReady = false;
let mapsPromise = null;

/**
 * Dynamically load Leaflet.js CSS + JS + Routing Machine from CDN.
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

        // Load Leaflet Routing Machine CSS
        const routingCss = document.createElement('link');
        routingCss.rel = 'stylesheet';
        routingCss.href = 'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css';
        document.head.appendChild(routingCss);

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
                // Load Leaflet Routing Machine
                const routingScript = document.createElement('script');
                routingScript.src = 'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.js';
                routingScript.onload = () => {
                    mapsReady = true;
                    resolve();
                };
                routingScript.onerror = () => {
                    // Routing Machine is optional — maps still work without it
                    console.warn('Leaflet Routing Machine failed to load, using fallback straight lines');
                    mapsReady = true;
                    resolve();
                };
                document.head.appendChild(routingScript);
            };
            heatScript.onerror = () => {
                // Heatmap plugin is optional — maps still work without it
                // Still load Routing Machine
                const routingScript = document.createElement('script');
                routingScript.src = 'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.js';
                routingScript.onload = () => {
                    mapsReady = true;
                    resolve();
                };
                routingScript.onerror = () => {
                    mapsReady = true;
                    resolve();
                };
                document.head.appendChild(routingScript);
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
    // Using Microsoft Fluent 3D Delivery Truck Emoji
    const truckImg = 'https://raw.githubusercontent.com/microsoft/fluentui-emoji/main/assets/Delivery%20truck/3D/delivery_truck_3d.png';
    return L.divIcon({
        className: 'custom-truck-marker',
        html: `<div style="width:48px;height:48px;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0px 8px 12px rgba(0,0,0,0.4));transform:scale(1.2);transition:transform 0.3s ease;">
                 <img src="${truckImg}" style="width:100%;height:100%;object-fit:contain;" alt="3D Truck">
               </div>`,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
        popupAnchor: [0, -20]
    });
}

/**
 * Create a driver marker icon (for driver location display on admin map)
 */
export function createDriverIcon() {
    if (!window.L) return null;
    return L.divIcon({
        className: 'custom-driver-marker',
        html: `<div style="width:28px;height:28px;background:#E05535;border:2px solid #fff;border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 3px 8px rgba(224,85,53,0.4)">
                 <span style="font-size:14px">👤</span>
               </div>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
        popupAnchor: [0, -16]
    });
}

/**
 * Add a road-following route between two points on the map using OSRM.
 * Falls back to a straight dashed polyline if Routing Machine is unavailable.
 *
 * @param {L.Map} map - Leaflet map instance
 * @param {[number, number]} start - [lat, lng] start point
 * @param {[number, number]} end - [lat, lng] end point
 * @param {Object} [options] - { color, weight, opacity, dashArray }
 * @returns {Object} A control/layer object with a `.remove()` method
 */
export function addRoadRoute(map, start, end, options = {}) {
    const color = options.color || '#7A8C3E';
    const weight = options.weight || 4;
    const opacity = options.opacity || 0.7;

    // Try Leaflet Routing Machine (OSRM-based, road-following)
    if (window.L && L.Routing && L.Routing.control) {
        const routeControl = L.Routing.control({
            waypoints: [
                L.latLng(start[0], start[1]),
                L.latLng(end[0], end[1])
            ],
            router: L.Routing.osrmv1({
                serviceUrl: 'https://router.project-osrm.org/route/v1',
                profile: 'driving'
            }),
            lineOptions: {
                styles: [
                    { color: color, opacity: opacity, weight: weight }
                ],
                addWaypoints: false,
                missingRouteTolerance: 50
            },
            createMarker: () => null, // Don't add default markers (we have our own)
            show: false,             // Don't show turn-by-turn instructions
            addWaypoints: false,     // Don't allow adding intermediate waypoints
            fitSelectedRoutes: false, // Don't auto-zoom to fit route
            routeWhileDragging: false,
            collapsible: false
        }).addTo(map);

        // Hide the routing instructions container that gets appended
        setTimeout(() => {
            const containers = map.getContainer().querySelectorAll('.leaflet-routing-container');
            containers.forEach(el => { el.style.display = 'none'; });
        }, 500);

        return routeControl;
    }

    // Fallback: straight dashed polyline
    return L.polyline([start, end], {
        color,
        weight: 3,
        opacity: 0.6,
        dashArray: '8, 8',
        lineJoin: 'round'
    }).addTo(map);
}

