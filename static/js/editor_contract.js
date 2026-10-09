/**
 * BlytzEditor contract — stub for teammate Fabric.js implementation.
 * Replace this file's internals; keep the public API stable.
 */
(function (global) {
  "use strict";

  let canvasState = { version: 1, objects: [], stub: true };
  const commitListeners = [];

  function notifyCommitted() {
    commitListeners.forEach(function (cb) {
      try {
        cb(canvasState);
      } catch (err) {
        console.error("BlytzEditor onCommittedChange error", err);
      }
    });
  }

  const BlytzEditor = {
    /**
     * @returns {object} Current canvas JSON
     */
    getCanvasJSON: function () {
      return JSON.parse(JSON.stringify(canvasState));
    },

    /**
     * @param {object|string} json
     */
    loadCanvasJSON: function (json) {
      if (typeof json === "string") {
        try {
          json = JSON.parse(json);
        } catch (e) {
          json = { version: 1, objects: [], stub: true };
        }
      }
      canvasState = json && typeof json === "object" ? json : { version: 1, objects: [] };
      const root = document.getElementById("editor-root");
      if (root) {
        root.dataset.loaded = "1";
        root.querySelector("[data-editor-stub-label]") &&
          (root.querySelector("[data-editor-stub-label]").textContent =
            "Canvas stub loaded (" + (canvasState.objects ? canvasState.objects.length : 0) + " objects)");
      }
      return canvasState;
    },

    /**
     * @returns {string} data-URL PNG (1x1 mock)
     */
    getPreviewPNG: function () {
      // 1x1 transparent PNG
      return "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    },

    /**
     * @param {(json: object) => void} cb
     */
    onCommittedChange: function (cb) {
      if (typeof cb === "function") {
        commitListeners.push(cb);
      }
      return function unsubscribe() {
        const idx = commitListeners.indexOf(cb);
        if (idx >= 0) commitListeners.splice(idx, 1);
      };
    },

    /** Stub helper so Save can mark a local edit during development */
    _stubCommit: function (patch) {
      canvasState = Object.assign({}, canvasState, patch || {}, { stubUpdatedAt: Date.now() });
      notifyCommitted();
    },
  };

  global.BlytzEditor = BlytzEditor;
})(window);
