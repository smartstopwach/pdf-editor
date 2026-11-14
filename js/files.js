/* Tiny IndexedDB helper used to hand a dropped/selected file from the
   landing page over to the editor page (files can't go through the URL). */
(function (global) {
  'use strict';

  var DB_NAME = 'pdfeditor-files';
  var STORE = 'files';
  var DB_VERSION = 1;

  function openDb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function genId() {
    return 'f_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function saveFile(file) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var id = genId();
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(file, id);
        tx.oncomplete = function () { resolve(id); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function getFile(id) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).get(id);
        req.onsuccess = function () { resolve(req.result || null); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  global.PdfFiles = { saveFile: saveFile, getFile: getFile, genId: genId };
})(window);
