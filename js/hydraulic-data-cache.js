/**
 * Caché compartida de datos hidráulicos basada en IndexedDB.
 *
 * Ubicación recomendada:
 *   /js/hydraulic-data-cache.js
 *
 * Estadísticos 1:
 *   import { getCachedDataset, setCachedDataset } from './js/hydraulic-data-cache.js';
 *
 * Estadísticos 2 y 3:
 *   import { getCachedDataset, setCachedDataset } from '../js/hydraulic-data-cache.js';
 */

const DATABASE_NAME = 'ControlRedHydraulicCache';
const DATABASE_VERSION = 1;
const DATA_STORE = 'datasets';
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function supportsIndexedDB() {
  return typeof window !== 'undefined' && 'indexedDB' in window;
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!supportsIndexedDB()) {
      resolve(null);
      return;
    }

    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATA_STORE)) {
        database.createObjectStore(DATA_STORE);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB está bloqueada por otra pestaña.'));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
  });
}

function transactionCompleted(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/**
 * Recupera un conjunto de datos si existe, coincide la versión y no ha caducado.
 */
export async function getCachedDataset(
  key,
  { version = 1, maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  const database = await openDatabase();
  if (!database) return null;

  try {
    const transaction = database.transaction(DATA_STORE, 'readonly');
    const record = await requestResult(
      transaction.objectStore(DATA_STORE).get(String(key)),
    );

    if (!record) return null;
    if (record.version !== version) return null;
    if (!Number.isFinite(record.savedAt)) return null;
    if (Number.isFinite(maxAgeMs) && Date.now() - record.savedAt > maxAgeMs) {
      return null;
    }

    return record.data ?? null;
  } finally {
    database.close();
  }
}

/**
 * Guarda datos estructurados. IndexedDB aplica structured clone, por lo que
 * admite arrays, objetos, Map, Set, fechas, blobs y valores primitivos.
 */
export async function setCachedDataset(key, data, { version = 1 } = {}) {
  const database = await openDatabase();
  if (!database) return false;

  try {
    const transaction = database.transaction(DATA_STORE, 'readwrite');
    transaction.objectStore(DATA_STORE).put(
      {
        version,
        savedAt: Date.now(),
        data,
      },
      String(key),
    );
    await transactionCompleted(transaction);
    return true;
  } finally {
    database.close();
  }
}

/**
 * Obtiene datos de caché o ejecuta loader para cargarlos y guardarlos.
 * Devuelve también el origen para facilitar diagnósticos de rendimiento.
 */
export async function getOrLoadDataset(
  key,
  loader,
  { version = 1, maxAgeMs = DEFAULT_MAX_AGE_MS } = {},
) {
  const cached = await getCachedDataset(key, { version, maxAgeMs });
  if (cached !== null) {
    return { data: cached, source: 'cache' };
  }

  if (typeof loader !== 'function') {
    throw new TypeError('loader debe ser una función asíncrona.');
  }

  const data = await loader();
  await setCachedDataset(key, data, { version });
  return { data, source: 'network' };
}

/** Elimina únicamente un conjunto de datos. */
export async function removeCachedDataset(key) {
  const database = await openDatabase();
  if (!database) return false;

  try {
    const transaction = database.transaction(DATA_STORE, 'readwrite');
    transaction.objectStore(DATA_STORE).delete(String(key));
    await transactionCompleted(transaction);
    return true;
  } finally {
    database.close();
  }
}

/** Elimina todos los conjuntos de datos, conservando la base y su estructura. */
export async function clearHydraulicDataCache() {
  const database = await openDatabase();
  if (!database) return false;

  try {
    const transaction = database.transaction(DATA_STORE, 'readwrite');
    transaction.objectStore(DATA_STORE).clear();
    await transactionCompleted(transaction);
    return true;
  } finally {
    database.close();
  }
}

/** Devuelve metadatos de la caché sin recuperar los datos completos. */
export async function getHydraulicCacheInfo() {
  const database = await openDatabase();
  if (!database) return [];

  try {
    const transaction = database.transaction(DATA_STORE, 'readonly');
    const store = transaction.objectStore(DATA_STORE);
    const keys = await requestResult(store.getAllKeys());
    const records = await requestResult(store.getAll());

    return keys.map((key, index) => ({
      key,
      version: records[index]?.version ?? null,
      savedAt: records[index]?.savedAt ?? null,
    }));
  } finally {
    database.close();
  }
}

export const HYDRAULIC_CACHE_DEFAULTS = Object.freeze({
  databaseName: DATABASE_NAME,
  databaseVersion: DATABASE_VERSION,
  maxAgeMs: DEFAULT_MAX_AGE_MS,
});
