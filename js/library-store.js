(function (root) {
  'use strict';
  const DB_NAME = 'yinyuetai-studio';
  const DB_VERSION = 2;
  const TRACK_STORE = 'tracks';
  const ALBUM_STORE = 'albums';

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(TRACK_STORE)) database.createObjectStore(TRACK_STORE, { keyPath: 'id' });
        if (!database.objectStoreNames.contains(ALBUM_STORE)) database.createObjectStore(ALBUM_STORE, { keyPath: 'name' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async function transaction(storeName, mode, action) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let request;
      try { request = action(store); }
      catch (error) { database.close(); reject(error); return; }
      tx.oncomplete = () => { database.close(); resolve(request?.result); };
      tx.onerror = () => { database.close(); reject(tx.error); };
      tx.onabort = () => { database.close(); reject(tx.error || new Error('曲库事务已中止')); };
    });
  }

  async function list() {
    const tracks = await transaction(TRACK_STORE, 'readonly', (store) => store.getAll());
    return (tracks || []).sort((a, b) => Number(b.createdAt) - Number(a.createdAt));
  }

  function put(track) {
    return transaction(TRACK_STORE, 'readwrite', (store) => store.put(track));
  }

  function putMany(tracks) {
    return transaction(TRACK_STORE, 'readwrite', (store) => {
      (tracks || []).forEach((track) => store.put(track));
    });
  }

  function remove(id) {
    return transaction(TRACK_STORE, 'readwrite', (store) => store.delete(id));
  }

  function removeMany(ids) {
    return transaction(TRACK_STORE, 'readwrite', (store) => {
      (ids || []).forEach((id) => store.delete(id));
    });
  }

  async function listAlbums() {
    const albums = await transaction(ALBUM_STORE, 'readonly', (store) => store.getAll());
    return (albums || []).sort((a, b) => Number(a.createdAt) - Number(b.createdAt));
  }

  function putAlbum(album) {
    return transaction(ALBUM_STORE, 'readwrite', (store) => store.put(album));
  }

  root.LibraryStore = { list, put, putMany, remove, removeMany, listAlbums, putAlbum };
})(typeof self !== 'undefined' ? self : this);
