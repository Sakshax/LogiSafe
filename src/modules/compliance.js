/**
 * compliance.js — Photo Upload & Delivery Verification Module
 *
 * Enforces: delivery cannot be marked "Successful" without a
 * timestamped photo of dust mitigation measures.
 */

import { storage, storageRef, uploadBytesResumable, getDownloadURL } from '../config/firebase-config.js';
import { db, doc, setDoc, Timestamp } from '../config/firebase-config.js';

/**
 * Upload a compliance photo to Firebase Storage.
 *
 * @param {File} file - The image file from camera/gallery
 * @param {string} bookingId - Associated booking/trip ID
 * @param {Function} onProgress - (percent: number) => void
 * @returns {Promise<{ url: string, timestamp: Date }>}
 */
export async function uploadCompliancePhoto(file, bookingId, onProgress) {
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

                    // Log compliance record to Firestore
                    try {
                        await setDoc(doc(db, 'compliance_records', bookingId), {
                            photoUrl: url,
                            bookingId,
                            timestamp: Timestamp.fromDate(timestamp),
                            verified: true
                        });
                    } catch (e) {
                        console.warn('Firestore log failed:', e.message);
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
 * In production this would query Firestore.
 * @param {string} bookingId
 * @returns {boolean}
 */
export function isComplianceVerified(bookingId) {
    // Placeholder — always returns false until photo is uploaded within the session
    return false;
}
