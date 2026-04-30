# LogiSafe Operational Workflow

This diagram illustrates the lifecycle of a delivery within the LogiSafe platform, detailing the interactions between Admins, Managers, and Drivers.

```mermaid
graph TD
    %% Entry Point
    Start((LogiSafe Portal)) --> Auth{Authentication}
    
    %% Auth Flow
    Auth -- New User --> Register[Register: Driver or Manager]
    Auth -- Existing --> Login[Login Redirect]
    
    Register --> AdminReview[Admin: Review Credentials]
    AdminReview -- Rejected --> Register
    AdminReview -- Approved --> Dashboard[Role-Based Dashboard]
    Login --> Dashboard

    %% Manager Path
    Dashboard -- Site Manager --> BookSlot[Book Delivery Slot]
    BookSlot --> ConflictCheck{Conflict Engine}
    ConflictCheck -- Overlap Found --> Suggest[Suggest Next Available Slot]
    Suggest --> BookSlot
    ConflictCheck -- Clear --> SlotConfirmed[Slot Confirmed in Firestore]

    %% Admin Path
    SlotConfirmed --> Assign[Admin: Assign Driver]
    Assign --> SendLink[Generate Tracking Token & WhatsApp Link]

    %% Driver Path
    SendLink --> DriverTrip[Driver: Open Secure Tracking View]
    DriverTrip --> LiveTelemetry[Start Live GPS Streaming]
    LiveTelemetry --> Geofence{Enters 500m Site Radius?}
    
    %% Realtime Alerts
    Geofence -- Yes --> ManagerAlert[Trigger Manager Dashboard Alert]
    ManagerAlert --> Compliance[Driver: Upload Dust Mitigation Photo]
    
    %% Finalization
    Compliance --> SiteAudit[Admin: Verify Evidence]
    SiteAudit --> Completed((Trip Completed & Logged))

    %% Styling
    style Start fill:#1C1C1C,color:#fff
    style Completed fill:#7A8C3E,color:#fff
    style ConflictCheck fill:#E05535,color:#fff
    style Geofence fill:#7A8C3E,color:#fff
    style ManagerAlert fill:#F4A623,color:#000
```

## Workflow Breakdown

### 1. Unified Authentication
Users enter through a shared portal. The system uses **Role-Based Access Control (RBAC)** to ensure that an Admin sees the Global Heatmap, while a Manager sees their specific Site Schedule.

### 2. Intelligent Scheduling
Site Managers use the **Conflict Detection Engine** to prevent road congestion. If a site is at capacity, the system prevents the booking and suggests the nearest free 30-minute window.

### 3. Dispatch & Tracking
Once a slot is confirmed, Admins assign an approved driver. A secure **Tracking Token** is generated, bypassing the need for the driver to log in. This link is sent via WhatsApp for immediate action.

### 4. Proximity & Compliance
When the truck's telemetry enters the **500m Geofence**, the Site Manager receives a visual "Priority Alert." Before unloading, the driver must upload a **Compliance Photo**, which is instantly logged in the Admin’s audit trail for regulatory verification.
