# LogiSafe System Requirements

This document outlines the minimum and recommended hardware and software specifications for the deployment and operation of the LogiSafe platform.

## 1. Hardware Requirements

### 💻 Administrator & Site Manager (Desktop/Laptop)
*   **Processor**: Intel Core i3 (9th Gen) or AMD Ryzen 3 (Equivalent) @ 2.4GHz or higher.
*   **Memory (RAM)**: 4 GB Minimum (8 GB Recommended for seamless multi-map handling).
*   **Storage**: 500 MB of cache availability for map tile local storage.
*   **Display**: Resolution of 1366 x 768 or higher (1920 x 1080 Recommended for Dashboard Heatmaps).
*   **Connectivity**: Stable broadband connection (Minimum 5 Mbps Download/Upload).

### 📱 Driver & Field Operations (Mobile Devices)
*   **Processor**: Any Octa-core processor capable of running modern mobile browsers.
*   **Memory (RAM)**: 2 GB Minimum.
*   **Integrated Hardware**:
    *   **GPS/GNSS**: Required for real-time telemetry and geofencing accuracy.
    *   **Camera**: Minimum 8MP for capturing clear compliance evidence and dust mitigation photos.
*   **Connectivity**: 4G LTE or 5G Mobile Data connection for high-frequency telemetry updates.
*   **Battery**: Stable battery life or in-vehicle charging support during transit.

---

## 2. Software Requirements

### 🌐 System & Browser Support
*   **Operating Systems**:
    *   **Desktop**: Windows 10/11, macOS (Latest 3 versions), Linux (Ubuntu/Fedora/Debian).
    *   **Mobile**: Android 10.0+ or iOS 15.0+.
*   **Web Browsers**: (Must support ES6+, CSS Grid, and Geolocation API)
    *   **Google Chrome**: Version 95 or higher (Recommended).
    *   **Microsoft Edge**: Version 95 or higher.
    *   **Safari**: Version 15 or higher.
    *   **Mozilla Firefox**: Version 90 or higher.

### 🛠️ Backend & Infrastructure (Cloud Stack)
*   **Platform-as-a-Service**: Vercel (Development and Production Hosting).
*   **Database**: Firebase Cloud Firestore (Real-time NoSQL).
*   **Authentication**: Firebase Auth (Identity Management).
*   **Storage**: Firebase Cloud Storage (Compliance Media Objects).

### 📚 Libraries & APIs
*   **Mapping Library**: Leaflet JS v1.9+ (Core Map Engine).
*   **Styling Engine**: Tailwind CSS v3.0+ (Responsive Layouts).
*   **Telemetry API**: HTML5 Geolocation API.
*   **Communication**: WhatsApp Cloud API or `wa.me` Protocol (for Dispatch Links).
*   **Geocoding**: OpenStreetMap Nominatim API (Reverse Address Lookup).
