/**
 * firebase-config.js — Firebase SDK Initialization (Modular v10)
 *
 * Uses ES module CDN imports so the app runs without npm/bundler.
 * Replace the placeholder values with your real Firebase project credentials.
 */

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-app.js";
import { getFirestore, collection, doc, setDoc, addDoc, getDocs, query, where, orderBy, limit, onSnapshot, serverTimestamp, Timestamp, deleteDoc } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-firestore.js";
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-auth.js";
import { getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL } from "https://www.gstatic.com/firebasejs/10.8.1/firebase-storage.js";

// ─── Firebase Configuration ─────────────────────────────────────────────
const firebaseConfig = {
    apiKey: "AIzaSyAzrRYeL8j1pm4_HNmoR86SIaA2f6SnZFo",
    authDomain: "logisafe-18bb2.firebaseapp.com",
    projectId: "logisafe-18bb2",
    storageBucket: "logisafe-18bb2.firebasestorage.app",
    messagingSenderId: "945287193159",
    appId: "1:945287193159:web:279e7c3862f87f34f68762"
};

const app = initializeApp(firebaseConfig);

// ─── Service Exports ────────────────────────────────────────────────────
export const db = getFirestore(app);
export const auth = getAuth(app);
export const storage = getStorage(app);

// ─── Re-export Firestore helpers so other modules stay clean ────────────
export {
    collection, doc, setDoc, addDoc, getDocs,
    query, where, orderBy, limit,
    onSnapshot, serverTimestamp, Timestamp, deleteDoc
};

// ─── Re-export Auth helpers ─────────────────────────────────────────────
export {
    signInWithEmailAndPassword, createUserWithEmailAndPassword,
    signOut, onAuthStateChanged
};

// ─── Re-export Storage helpers ──────────────────────────────────────────
export { storageRef, uploadBytesResumable, getDownloadURL };
