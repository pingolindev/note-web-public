/*
 * Copyright (c) 2026 Pingolin LLC
 * This file is part of Pingolin Note.
 *
 * Pingolin Note is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * Pingolin Note is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with Pingolin Note. If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Web Push subscription management.
 *
 * Registers the service worker (SW_URL, shared with offlineShell.ts),
 * requests a PushSubscription keyed to the server's VAPID
 * public key, and posts the subscription endpoint + keys to the backend so
 * the server can dispatch reminders via a push service.
 *
 * Subscription is idempotent — we store the last-registered endpoint in
 * localStorage and skip re-posting if it's unchanged.
 */
import { apiRequest } from './apiClient';
import { SW_URL, isIosShell } from './offlineShell';
import { scopedGetItem, scopedRemoveItem, scopedSetItem } from './account';

/** How long a push subscription will wait for the worker to become active. */
const READY_TIMEOUT_MS = 15_000;

const STORED_ENDPOINT_KEY = 'pingolin_note_push_endpoint';

/** VAPID public key is injected at build time or fetched from config endpoint. */
let cachedVapidKey: string | null = null;

async function fetchVapidPublicKey(): Promise<string | null> {
  if (cachedVapidKey) return cachedVapidKey;
  const r = await apiRequest<{ key: string }>('/api/v1/push/vapid-public-key');
  if (!r.success) return null;
  cachedVapidKey = r.data.key;
  return cachedVapidKey;
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bufferToBase64Url(buf: ArrayBuffer | null | undefined): string {
  if (!buf) return '';
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function isPushSupported(): Promise<boolean> {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/**
 * Register the service worker and subscribe if not already subscribed.
 * Returns the active subscription or null on failure.
 */
export async function ensurePushSubscription(): Promise<PushSubscription | null> {
  // The other site that could register a worker. The iOS shell keeps none
  // (offlineShell.ts header), and its reminders come by APNs, not Web Push.
  if (isIosShell()) return null;
  if (!(await isPushSupported())) return null;
  if (Notification.permission !== 'granted') return null;

  try {
    // Same script URL as the startup registration (offlineShell.ts) — two
    // different URLs on one scope would flip the registration back and forth.
    const registration = await navigator.serviceWorker.register(SW_URL, { updateViaCache: 'none' });
    // `.ready` resolves only once a worker is ACTIVE. Since the worker
    // precaches the build in `install`, a first visit waits for that whole
    // download here — and if the precache fails (a hashed asset 404s because a
    // deploy landed between page load and install; storage pressure) there is
    // never an active worker and `.ready` never settles, which no try/catch
    // can rescue. Bounded: give up on the subscription this time rather than
    // hang a promise the reminder picker fire-and-forgets.
    const ready = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), READY_TIMEOUT_MS)),
    ]);
    if (!ready) return null;

    let sub = await registration.pushManager.getSubscription();
    if (!sub) {
      const key = await fetchVapidPublicKey();
      if (!key) return null;
      sub = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key),
      });
    }

    // Register with backend (idempotent — server upserts by endpoint)
    const previous = scopedGetItem(STORED_ENDPOINT_KEY);
    if (previous !== sub.endpoint) {
      const p256dh = bufferToBase64Url(sub.getKey('p256dh'));
      const auth = bufferToBase64Url(sub.getKey('auth'));
      const r = await apiRequest('/api/v1/push/subscribe', {
        method: 'POST',
        body: {
          endpoint: sub.endpoint,
          p256dh,
          auth,
          user_agent: navigator.userAgent.slice(0, 200),
        },
      });
      if (r.success) scopedSetItem(STORED_ENDPOINT_KEY, sub.endpoint);
    }
    return sub;
  } catch (e) {
    console.warn('Push subscription failed:', e);
    return null;
  }
}

export async function unsubscribePush(): Promise<boolean> {
  if (!(await isPushSupported())) return false;
  try {
    // No argument: the registration controlling THIS page. The script URL
    // only ever matched because scope `/` matches everything.
    const registration = await navigator.serviceWorker.getRegistration();
    const sub = await registration?.pushManager.getSubscription();
    if (!sub) return true;
    const endpoint = sub.endpoint;
    await sub.unsubscribe();
    await apiRequest('/api/v1/push/subscribe', {
      method: 'DELETE',
      body: { endpoint },
    });
    scopedRemoveItem(STORED_ENDPOINT_KEY);
    return true;
  } catch {
    return false;
  }
}
