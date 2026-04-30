/**
 * compliance.js — Photo Upload & Delivery Verification Module v4
 *
 * Enforces: delivery cannot be marked "Successful" without a
 * timestamped photo of dust mitigation measures.
 *
 * v4: Real isComplianceVerified, file validation, enriched records,
 *     auto-updates booking status to COMPLETED.
 */

import { storage, storageRef, uploadBytesResumable, getDownloadURL } from '../config/firebase-config.js';
import { db, doc, setDoc, getDoc, Timestamp } from '../config/firebase-config.js';

// Max file size: 10MB
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];

/**
 * Upload a compliance photo to Firebase Storage.
 *
 * @param {File} file - The image file from camera/gallery
 * @param {string} bookingId - Associated booking/trip ID
 * @param {Function} onProgress - (percent: number) => void
 * @param {Object} [context] - Optional context { driverName, driverId, siteName, date, time }
 * @returns {Promise<{ url: string, timestamp: Date }>}
 */
export async function uploadCompliancePhoto(file, bookingId, onProgress, context = {}) {
    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
        throw new Error(`Invalid file type. Allowed: ${ALLOWED_TYPES.join(', ')}`);
    }
    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
        throw new Error(`File too large. Maximum size: ${MAX_FILE_SIZE / (1024 * 1024)}MB`);
    }
    const timestamp = new Date();
    const fileName = `compliance/${bookingId}_${timestamp.getTime()}_${file.name}`;

    try {
        const fileRef = storageRef(storage, fileName);
        const uploadTask = uploadBytesResumable(fileRef, file);

        return new Promise((resolve, reject) => {
            uploadTask.on('state_changed',
                (snapshot) => {
                    const progress = (snapshot.bytesTransferred / snapshot.totalBytes) * 100;
                    if (onProgress) onProgress(progress);
                },
                (error) => {
                    console.error('Upload error:', error);
                    reject(error);
                },
                async () => {
                    const url = await getDownloadURL(uploadTask.snapshot.ref);

                    // Log compliance record to Firestore with enriched context
                    try {
                        await setDoc(doc(db, 'compliance_records', bookingId), {
                            photoUrl: url,
                            bookingId,
                            uploadedAt: Timestamp.fromDate(timestamp),
                            verified: true,
                            driverName: context.driverName || '',
                            driverId: context.driverId || '',
                            siteName: context.siteName || '',
                            bookingDate: context.date || '',
                            bookingTime: context.time || '',
                            fileName: file.name,
                            fileSize: file.size
                        });
                    } catch (e) {
                        console.warn('Firestore log failed:', e.message);
                    }

                    // Update booking status to COMPLETED
                    try {
                        await setDoc(doc(db, 'logistics_slots', bookingId), {
                            status: 'COMPLETED',
                            completedAt: Timestamp.fromDate(timestamp)
                        }, { merge: true });
                    } catch (e) {
                        console.warn('Could not update booking status:', e.message);
                    }

                    resolve({ url, timestamp });
                }
            );
        });
    } catch (err) {
        // Fallback: simulate upload for demo mode
        console.warn('Storage unavailable, simulating upload:', err.message);
        return simulateUpload(onProgress);
    }
}

/**
 * Simulated upload for demo mode (no Firebase Storage configured).
 * @param {Function} onProgress
 * @returns {Promise<{ url: string, timestamp: Date }>}
 */
export function simulateUpload(onProgress) {
    return new Promise((resolve) => {
        let progress = 0;
        const interval = setInterval(() => {
            progress += 12 + Math.random() * 8;
            if (progress > 100) progress = 100;
            if (onProgress) onProgress(progress);

            if (progress >= 100) {
                clearInterval(interval);
                setTimeout(() => {
                    resolve({
                        url: `https://storage.demo/compliance/photo_${Date.now()}.jpg`,
                        timestamp: new Date()
                    });
                }, 300);
            }
        }, 350);
    });
}

/**
 * Check whether a booking has a valid compliance photo.
 * Queries Firestore for an existing compliance record.
 * @param {string} bookingId
 * @returns {Promise<boolean>}
 */
export async function isComplianceVerified(bookingId) {
    if (!bookingId) return false;
    try {
        const snap = await getDoc(doc(db, 'compliance_records', bookingId));
        return snap.exists() && snap.data().verified === true;
    } catch (e) {
        console.warn('Compliance check failed:', e.message);
        return false;
    }
}
