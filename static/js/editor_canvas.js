/**
 * Fabric.js workspace for the Blytz design editor.
 * Logical size: 800×800 (provisional working canvas, not production print size).
 * Public API lives on window.BlytzEditor (see editor_contract.js).
 */
(function (global) {
  "use strict";

  var fabricVersionOk = !!(
    global.fabric &&
    String(global.fabric.version) === "6.6.1"
  );
  if (global.fabric && !fabricVersionOk) {
    console.warn(
      "BlytzCanvas: Fabric " +
        String(global.fabric.version) +
        " detected; multi-select workaround and several behaviors were verified only against 6.6.1."
    );
  }

  var LOGICAL_SIZE = 800;
  var SCHEMA_VERSION = 1;
  /** Max UTF-8 bytes for serialized canvas_json (whole envelope) in Save/Submit. */
  var MAX_CANVAS_JSON_BYTES = 2 * 1024 * 1024;
  /** Soft budget for image inserts (fraction of MAX_CANVAS_JSON_BYTES). */
  var IMAGE_INSERT_BUDGET_RATIO = 0.8;
  /** Input file size limit before decode (bytes). Replaces former MAX_IMAGE_BYTES. */
  var IMAGE_INPUT_LIMIT_BYTES = 8 * 1024 * 1024;
  /** Longest edge after downscale (px). */
  var IMAGE_MAX_EDGE = 1200;
  /** Target encoded size after downscale (bytes). */
  var IMAGE_TARGET_BYTES = 300 * 1024;
  var IMAGE_QUALITY_STEPS = [0.85, 0.75, 0.6, 0.5];
  var IMAGE_EDGE_STEPS = [1200, 1000, 800];
  /** Reject decoded images with more pixels than this. */
  var IMAGE_MAX_PIXELS = 40000000;
  var ALLOWED_IMAGE_TYPES = {
    "image/png": true,
    "image/jpeg": true,
    "image/jpg": true,
    "image/webp": true,
  };
  /** Web-safe fonts for text tools / later properties panel. */
  var ALLOWED_FONTS = [
    "Arial",
    "Verdana",
    "Georgia",
    "Times New Roman",
    "Courier New",
    "Impact",
  ];
  var DEFAULT_SHAPE_FILL = "#1a1a1a";
  var DEFAULT_SHAPE_MAX_EDGE = 200;
  var INSERT_CASCADE_STEP = 24;
  var INSERT_CASCADE_MAX_STEPS = 5;

  /**
   * Types accepted by validateCanvasJSON (suggestions / preview / apply).
   * Case-insensitive. Groups not allowed yet.
   * Found in product code today: IText, Rect (AI mock); IText (addText); Image (addImage).
   */
  var ALLOWED_OBJECT_TYPES = {
    rect: true,
    ellipse: true,
    circle: true,
    line: true,
    polygon: true,
    path: true,
    text: true,
    itext: true,
    textbox: true,
    image: true,
  };

  var ALLOWED_IMAGE_SRC_PREFIXES = [
    "data:image/png;base64,",
    "data:image/jpeg;base64,",
    "data:image/webp;base64,",
  ];

  /** Extra Fabric props to serialize. Reserved for later: blytzLocked. */
  var SERIALIZE_PROPS = ["selectable", "evented", "blytzId", "blytzName"];
  /** Color swatches for the properties panel (native picker + presets). */
  var COLOR_PRESETS = [
    "#000000",
    "#ffffff",
    "#e11d48",
    "#f97316",
    "#eab308",
    "#16a34a",
    "#2563eb",
    "#7c3aed",
  ];
  /** Clamp limits for property edits. */
  var PROP_LIMITS = {
    opacityMin: 0,
    opacityMax: 1,
    rotationMin: 0,
    rotationMax: 359,
    strokeWidthMin: 0,
    strokeWidthMax: 50,
    fontSizeMin: 8,
    fontSizeMax: 300,
    sizeMin: 8,
    sizeMax: 1600,
    posMin: -400,
    posMax: 1200,
    textMin: 1,
    textMax: 200,
  };

  var fabricCanvas = null;
  var getJSONRef = null;
  var loadGeneration = 0;
  var suppressCommit = false;
  var lastLoadError = "";
  var resizeObserver = null;
  var lastAppliedDisplaySize = 0;
  var resizeApplyScheduled = false;
  var toolsWired = false;
  var eventsBound = false;
  var blytzIdSeq = 0;
  var multiSelectMode = false;
  var multiSelectPointerWired = false;
  var contextMenuWired = false;
  var touchHandlesApplied = false;
  var insertCascadeStep = 0;
  var textAtEditStart = null;
  /** Optional UI message sink (panel live region); falls back to tool feedback. */
  var messageSink = null;

  /** B1 two-view engine: live Fabric = active view; inactive snapshots in viewStore. */
  var activeView = "front";
  var viewStore = { back: null };
  var viewChangeListeners = [];
  /** VIEW_SWITCH_DURING_AI_PREVIEW switch (prompt): blocked while AI candidates pending. */
  var VIEW_SWITCH_DURING_AI_PREVIEW = "blocked";
  var garmentState = { template: "tee", color: "black" };
  var garmentChangeListeners = [];

  /** Internal hooks for a future history system — unused in Stage 3a. */
  var beforeCommitHooks = [];
  var afterCommitHooks = [];

  function fabricNS() {
    return global.fabric;
  }

  function utf8ByteLength(str) {
    if (typeof TextEncoder !== "undefined") {
      return new TextEncoder().encode(str).length;
    }
    return unescape(encodeURIComponent(str)).length;
  }

  function setToolFeedback(msg) {
    document.querySelectorAll("[data-editor-tool-feedback]").forEach(function (el) {
      el.textContent = msg || "";
    });
    var status = document.querySelector("[data-editor-status]");
    if (status && msg) status.textContent = msg;
    if (typeof messageSink === "function") {
      try {
        messageSink(msg || "");
      } catch (err) {
        /* ignore sink errors */
      }
    }
  }

  function setMessageSink(fn) {
    messageSink = typeof fn === "function" ? fn : null;
  }

  function nextInsertCenter() {
    var offset = (insertCascadeStep % (INSERT_CASCADE_MAX_STEPS + 1)) * INSERT_CASCADE_STEP;
    insertCascadeStep += 1;
    if (insertCascadeStep > INSERT_CASCADE_MAX_STEPS) insertCascadeStep = 0;
    var half = DEFAULT_SHAPE_MAX_EDGE / 2;
    var cx = Math.min(LOGICAL_SIZE - half, Math.max(half, LOGICAL_SIZE / 2 + offset));
    var cy = Math.min(LOGICAL_SIZE - half, Math.max(half, LOGICAL_SIZE / 2 + offset));
    return { left: cx, top: cy };
  }

  function emptyFabricCanvasObject() {
    return { version: (fabricNS() && fabricNS().version) || "6.6.1", objects: [] };
  }

  function emptyEnvelope() {
    return {
      schema_version: SCHEMA_VERSION,
      width: LOGICAL_SIZE,
      height: LOGICAL_SIZE,
      canvas: emptyFabricCanvasObject(),
      views: { back: emptyFabricCanvasObject() },
    };
  }

  function cloneFabricPayload(payload) {
    return JSON.parse(JSON.stringify(payload || emptyFabricCanvasObject()));
  }

  function snapshotLiveCanvas() {
    if (!fabricCanvas) return emptyFabricCanvasObject();
    return fabricCanvas.toObject(SERIALIZE_PROPS);
  }

  function forceTransparentBackground() {
    if (!fabricCanvas) return;
    fabricCanvas.backgroundColor = "";
    if (typeof fabricCanvas.setBackgroundColor === "function") {
      try {
        fabricCanvas.setBackgroundColor("", fabricCanvas.requestRenderAll.bind(fabricCanvas));
      } catch (err) {
        fabricCanvas.backgroundColor = "";
      }
    }
    sanitizeCanvasDom();
    fabricCanvas.requestRenderAll();
  }

  function defaultContrastFill() {
    var g = global.BlytzGarments;
    if (g && typeof g.contrastColor === "function" && typeof g.colorById === "function") {
      var c = g.colorById(garmentState.color);
      return g.contrastColor(c && c.hex ? c.hex : "#ffffff");
    }
    return "#111111";
  }

  function refreshGarmentLayer() {
    var g = global.BlytzGarments;
    if (g && typeof g.renderGarmentLayer === "function") {
      try {
        g.renderGarmentLayer(garmentState.template, garmentState.color, activeView);
      } catch (err) {
        console.warn("BlytzCanvas: garment layer render failed", err);
      }
    }
  }

  function aiCandidatesPending() {
    var ai = global.BlytzAIChat;
    if (!ai || typeof ai.getState !== "function") return false;
    var st = ai.getState();
    return !!(st && st.candidateCount > 0 && !st.committed);
  }

  function isLegacyEmpty(data) {
    if (!data || typeof data !== "object" || Array.isArray(data)) return true;
    if (Object.prototype.hasOwnProperty.call(data, "schema_version")) return false;
    var objects = data.objects;
    if (objects == null) return true;
    return Array.isArray(objects) && objects.length === 0;
  }

  function isBlytzV1(data) {
    return (
      data &&
      typeof data === "object" &&
      data.schema_version === SCHEMA_VERSION &&
      data.canvas &&
      typeof data.canvas === "object" &&
      !Array.isArray(data.canvas)
    );
  }

  function isRawFabricCanvas(data) {
    return (
      data &&
      typeof data === "object" &&
      typeof data.version === "string" &&
      Array.isArray(data.objects)
    );
  }

  function isUnsupportedLegacy(data) {
    if (!data || typeof data !== "object") return false;
    if (Object.prototype.hasOwnProperty.call(data, "schema_version")) return false;
    if (isRawFabricCanvas(data)) return false;
    return Array.isArray(data.objects) && data.objects.length > 0;
  }

  function isUnknownSchemaVersion(data) {
    return (
      data &&
      typeof data === "object" &&
      Object.prototype.hasOwnProperty.call(data, "schema_version") &&
      data.schema_version !== SCHEMA_VERSION
    );
  }

  /**
   * Normalize incoming design JSON.
   * @returns {{
   *   ok: boolean,
   *   blockPersist: boolean,
   *   message: string,
   *   kind: string,
   *   envelope: object,
   *   fabricPayload: object
   * }}
   */
  function parseInput(json) {
    lastLoadError = "";
    if (typeof json === "string") {
      try {
        json = JSON.parse(json);
      } catch (e) {
        lastLoadError =
          "This design could not be read (invalid JSON). Saving is blocked so your stored design is not overwritten. Reload the page or go back.";
        return {
          ok: false,
          blockPersist: true,
          message: lastLoadError,
          kind: "malformed",
          envelope: emptyEnvelope(),
          fabricPayload: emptyFabricCanvasObject(),
        };
      }
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return {
        ok: true,
        blockPersist: false,
        message: "",
        kind: "empty",
        envelope: emptyEnvelope(),
        fabricPayload: emptyFabricCanvasObject(),
      };
    }
    if (isUnknownSchemaVersion(json)) {
      lastLoadError =
        "This design uses an unsupported canvas schema version (" +
        String(json.schema_version) +
        "). Saving is blocked so the original is not overwritten. Reload or go back.";
      return {
        ok: false,
        blockPersist: true,
        message: lastLoadError,
        kind: "unsupported_schema",
        envelope: emptyEnvelope(),
        fabricPayload: emptyFabricCanvasObject(),
      };
    }
    if (isBlytzV1(json)) {
      var envelopeV1 = {
        schema_version: SCHEMA_VERSION,
        width: typeof json.width === "number" ? json.width : LOGICAL_SIZE,
        height: typeof json.height === "number" ? json.height : LOGICAL_SIZE,
        canvas: json.canvas,
      };
      // Additive views key (B1): carry through; do not drop unknown-to-legacy keys here.
      if (Object.prototype.hasOwnProperty.call(json, "views")) {
        envelopeV1.views = json.views;
      }
      return {
        ok: true,
        blockPersist: false,
        message: "",
        kind: "blytz_v1",
        envelope: envelopeV1,
        fabricPayload: json.canvas,
      };
    }
    if (isLegacyEmpty(json)) {
      return {
        ok: true,
        blockPersist: false,
        message: "",
        kind: "legacy_empty",
        envelope: emptyEnvelope(),
        fabricPayload: emptyFabricCanvasObject(),
      };
    }
    if (isRawFabricCanvas(json)) {
      return {
        ok: true,
        blockPersist: false,
        message: "",
        kind: "raw_fabric",
        envelope: {
          schema_version: SCHEMA_VERSION,
          width: LOGICAL_SIZE,
          height: LOGICAL_SIZE,
          canvas: json,
        },
        fabricPayload: json,
      };
    }
    if (isUnsupportedLegacy(json)) {
      lastLoadError =
        "This design uses an unsupported legacy canvas format. Saving is blocked so the original is not overwritten. Reload or go back.";
      return {
        ok: false,
        blockPersist: true,
        message: lastLoadError,
        kind: "unsupported_legacy",
        envelope: emptyEnvelope(),
        fabricPayload: emptyFabricCanvasObject(),
      };
    }
    lastLoadError =
      "Unrecognized canvas data. Saving is blocked so the original is not overwritten. Reload or go back.";
    return {
      ok: false,
      blockPersist: true,
      message: lastLoadError,
      kind: "unrecognized",
      envelope: emptyEnvelope(),
      fabricPayload: emptyFabricCanvasObject(),
    };
  }

  function imageSrcAllowed(src) {
    if (typeof src !== "string" || !src) return false;
    var lower = src.toLowerCase();
    for (var i = 0; i < ALLOWED_IMAGE_SRC_PREFIXES.length; i++) {
      if (lower.indexOf(ALLOWED_IMAGE_SRC_PREFIXES[i]) === 0) return true;
    }
    return false;
  }

  /**
   * Suggestion allowlist — delegates to scanCanvasPayload (shared safety rules).
   * Must stay identical to apps/designs/canvas_safety.py.
   */
  function validateObjectsAllowlist(objects) {
    if (!Array.isArray(objects)) {
      return { ok: false, error: "Suggestion canvas.objects must be an array." };
    }
    var scanned = scanCanvasPayload({
      schema_version: SCHEMA_VERSION,
      canvas: { objects: objects },
    });
    if (!scanned.ok) {
      return {
        ok: false,
        error: (scanned.reason || "Suggestion failed safety checks.") + " Please retry.",
      };
    }
    return { ok: true };
  }

  function runHooks(hooks, label, snapshot) {
    if (!hooks || !hooks.length) return;
    for (var i = 0; i < hooks.length; i++) {
      try {
        hooks[i](label, snapshot);
      } catch (err) {
        console.error("BlytzCanvas commit hook error", err);
      }
    }
  }

  function notifyCommitted(getJSON, label) {
    if (suppressCommit) return;
    var listeners = global.BlytzEditor && global.BlytzEditor._commitListeners;
    var snapshot = typeof getJSON === "function" ? getJSON() : null;
    runHooks(beforeCommitHooks, label || "commit", snapshot);
    if (listeners && listeners.length) {
      listeners.forEach(function (cb) {
        try {
          cb(snapshot);
        } catch (err) {
          console.error("BlytzEditor onCommittedChange error", err);
        }
      });
    }
    runHooks(afterCommitHooks, label || "commit", snapshot);
  }

  /**
   * Central mutation pathway: suppress per-event noise, then one notifyCommitted.
   * applyFn may return false to skip the commit notification.
   */
  function commitEdit(label, applyFn, getJSON) {
    var jsonFn = getJSON || getJSONRef;
    var prev = suppressCommit;
    suppressCommit = true;
    var changed = false;
    try {
      var result = applyFn();
      changed = result !== false;
    } finally {
      suppressCommit = prev;
    }
    if (changed) {
      notifyCommitted(jsonFn, label || "edit");
    }
    return changed;
  }

  var textEditDirty = false;
  /** Ignore object:modified shortly after text:editing:exited (Fabric often double-fires). */
  var suppressModifiedUntil = 0;

  function newBlytzId() {
    blytzIdSeq += 1;
    return (
      "b" +
      blytzIdSeq.toString(36) +
      "_" +
      Math.random().toString(36).slice(2, 8)
    );
  }

  function ensureBlytzIds(canvas) {
    if (!canvas) return;
    var seen = Object.create(null);
    var objects = canvas.getObjects();
    for (var i = 0; i < objects.length; i++) {
      var obj = objects[i];
      var id = obj && obj.blytzId;
      if (typeof id !== "string" || !id || seen[id]) {
        id = newBlytzId();
        obj.blytzId = id;
      }
      seen[id] = true;
    }
  }

  function assignBlytzId(obj) {
    if (!obj) return;
    if (typeof obj.blytzId !== "string" || !obj.blytzId) {
      obj.blytzId = newBlytzId();
    }
  }

  function assignBlytzName(obj, name) {
    if (!obj || typeof name !== "string" || !name) return;
    if (typeof obj.blytzName !== "string" || !obj.blytzName) {
      obj.blytzName = name;
    }
  }

  /** Run applyFn without firing commit notifications (live property preview). */
  function runSilent(applyFn) {
    var prev = suppressCommit;
    suppressCommit = true;
    try {
      return applyFn();
    } finally {
      suppressCommit = prev;
    }
  }

  /**
   * Normalize Fabric type strings for branching (e.g. "i-text" → "itext").
   * Does not alter serialized type values on disk / in JSON.
   */
  function typeKey(typeOrObj) {
    var raw = typeOrObj;
    if (typeOrObj && typeof typeOrObj === "object") {
      raw = typeOrObj.type;
    }
    return String(raw || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  }

  function isActiveSelection(obj) {
    if (!obj) return false;
    return typeKey(obj) === "activeselection";
  }

  /**
   * Shared canvas safety scan (client). Must stay identical to
   * apps/designs/canvas_safety.py — keep both rule sets in sync.
   * Walks envelopes / Fabric canvases; never modifies values.
   * @returns {{ok: boolean, reason: string, path: string}}
   */
  function scanCanvasPayload(envelopeOrCanvas) {
    var MAX_DEPTH = 20;
    var SAFE = ALLOWED_OBJECT_TYPES;
    var URL_KEY = {
      src: true,
      source: true,
      url: true,
      href: true,
      "xlink:href": true,
    };

    function fail(reason, path) {
      return { ok: false, reason: reason || "rejected", path: path || "" };
    }

    function ok() {
      return { ok: true, reason: "", path: "" };
    }

    function dataUrlOk(s) {
      if (typeof s !== "string" || !s) return false;
      var lower = s.toLowerCase();
      for (var i = 0; i < ALLOWED_IMAGE_SRC_PREFIXES.length; i++) {
        if (lower.indexOf(ALLOWED_IMAGE_SRC_PREFIXES[i]) === 0) return true;
      }
      return false;
    }

    function scanUrlKeys(node, path, depth) {
      if (depth > MAX_DEPTH) return fail("Exceeded maximum nesting depth.", path);
      if (!node || typeof node !== "object") return ok();
      if (Array.isArray(node)) {
        for (var i = 0; i < node.length; i++) {
          var ra = scanUrlKeys(node[i], path + "[" + i + "]", depth + 1);
          if (!ra.ok) return ra;
        }
        return ok();
      }
      var keys = Object.keys(node);
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k];
        var val = node[key];
        var keyLower = String(key).toLowerCase();
        if (key === "text") {
          continue;
        }
        if (URL_KEY[key] || URL_KEY[keyLower] || keyLower === "xlink:href") {
          if (typeof val === "string" && !dataUrlOk(val)) {
            return fail(
              "External or unsafe image source is not allowed.",
              path + "." + key
            );
          }
        }
        if (val && typeof val === "object") {
          var rb = scanUrlKeys(val, path + "." + key, depth + 1);
          if (!rb.ok) return rb;
        }
      }
      return ok();
    }

    function scanFabricObject(obj, path, depth) {
      if (depth > MAX_DEPTH) return fail("Exceeded maximum nesting depth.", path);
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
        return fail("Invalid canvas object.", path);
      }
      var tk = typeKey(obj);
      if (!SAFE[tk]) {
        return fail(
          "Unsupported object type (“" + String(obj.type || "unknown") + "”).",
          path + ".type"
        );
      }
      if (obj.fill && typeof obj.fill === "object" && !Array.isArray(obj.fill)) {
        if (Object.prototype.hasOwnProperty.call(obj.fill, "source")) {
          return fail("Pattern fills are not allowed.", path + ".fill");
        }
      }
      if (obj.stroke && typeof obj.stroke === "object" && !Array.isArray(obj.stroke)) {
        if (Object.prototype.hasOwnProperty.call(obj.stroke, "source")) {
          return fail("Pattern strokes are not allowed.", path + ".stroke");
        }
      }
      if (obj.backgroundImage != null) {
        return fail("backgroundImage is not allowed.", path + ".backgroundImage");
      }
      if (obj.overlayImage != null) {
        return fail("overlayImage is not allowed.", path + ".overlayImage");
      }
      if (obj.objects != null) {
        if (!Array.isArray(obj.objects)) {
          return fail("objects must be an array.", path + ".objects");
        }
        for (var i = 0; i < obj.objects.length; i++) {
          var ro = scanFabricObject(
            obj.objects[i],
            path + ".objects[" + i + "]",
            depth + 1
          );
          if (!ro.ok) return ro;
        }
      }
      if (obj.clipPath != null) {
        var rc = scanFabricObject(obj.clipPath, path + ".clipPath", depth + 1);
        if (!rc.ok) return rc;
      }
      return scanUrlKeys(obj, path, depth);
    }

    function scanCanvasRoot(canvas, path, depth) {
      if (depth > MAX_DEPTH) return fail("Exceeded maximum nesting depth.", path);
      if (!canvas || typeof canvas !== "object" || Array.isArray(canvas)) {
        return fail("Invalid canvas payload.", path);
      }
      if (canvas.backgroundImage != null) {
        return fail("backgroundImage is not allowed.", path + ".backgroundImage");
      }
      if (canvas.overlayImage != null) {
        return fail("overlayImage is not allowed.", path + ".overlayImage");
      }
      if (canvas.objects != null) {
        if (!Array.isArray(canvas.objects)) {
          return fail("canvas.objects must be an array.", path + ".objects");
        }
        for (var i = 0; i < canvas.objects.length; i++) {
          var ro = scanFabricObject(
            canvas.objects[i],
            path + ".objects[" + i + "]",
            depth + 1
          );
          if (!ro.ok) return ro;
        }
      }
      return scanUrlKeys(canvas, path, depth);
    }

    if (!envelopeOrCanvas || typeof envelopeOrCanvas !== "object") {
      return fail("Invalid payload.", "");
    }

    // Blytz envelope (schema_version 1 or has canvas key).
    if (
      Object.prototype.hasOwnProperty.call(envelopeOrCanvas, "schema_version") ||
      Object.prototype.hasOwnProperty.call(envelopeOrCanvas, "canvas")
    ) {
      if (envelopeOrCanvas.canvas != null) {
        var rCanvas = scanCanvasRoot(envelopeOrCanvas.canvas, "canvas", 0);
        if (!rCanvas.ok) return rCanvas;
      }
      if (envelopeOrCanvas.views != null) {
        var views = envelopeOrCanvas.views;
        if (typeof views !== "object" || Array.isArray(views)) {
          return fail("Invalid views object.", "views");
        }
        var vkeys = Object.keys(views);
        for (var vi = 0; vi < vkeys.length; vi++) {
          var vk = vkeys[vi];
          if (vk === "front") {
            return fail("views.front is not allowed.", "views.front");
          }
          if (vk !== "back") {
            return fail("Unknown views key.", "views." + vk);
          }
          var back = views.back;
          if (!back || typeof back !== "object" || Array.isArray(back)) {
            return fail("Invalid views.back payload.", "views.back");
          }
          if (!Array.isArray(back.objects)) {
            return fail("views.back.objects must be an array.", "views.back.objects");
          }
          var rb = scanCanvasRoot(back, "views.back", 0);
          if (!rb.ok) return rb;
        }
      }
      return ok();
    }

    // Raw Fabric canvas object.
    return scanCanvasRoot(envelopeOrCanvas, "canvas", 0);
  }

  function buildEnvelopeFromCanvas() {
    // B1: canvas is ALWAYS front; views.back always present.
    var frontPayload;
    var backPayload;
    if (!fabricCanvas) {
      frontPayload = emptyFabricCanvasObject();
      backPayload = viewStore.back
        ? cloneFabricPayload(viewStore.back)
        : emptyFabricCanvasObject();
    } else if (activeView === "front") {
      frontPayload = snapshotLiveCanvas();
      backPayload = viewStore.back
        ? cloneFabricPayload(viewStore.back)
        : emptyFabricCanvasObject();
    } else {
      frontPayload = viewStore.front
        ? cloneFabricPayload(viewStore.front)
        : emptyFabricCanvasObject();
      backPayload = snapshotLiveCanvas();
    }
    return {
      schema_version: SCHEMA_VERSION,
      width: LOGICAL_SIZE,
      height: LOGICAL_SIZE,
      canvas: frontPayload,
      views: { back: backPayload },
    };
  }

  function getActiveCanvasJSON() {
    var live = fabricCanvas ? snapshotLiveCanvas() : emptyFabricCanvasObject();
    return {
      schema_version: SCHEMA_VERSION,
      width: LOGICAL_SIZE,
      height: LOGICAL_SIZE,
      canvas: live,
    };
  }

  function getActiveView() {
    return activeView;
  }

  function onViewChange(cb) {
    if (typeof cb === "function") viewChangeListeners.push(cb);
    return function unsubscribe() {
      var idx = viewChangeListeners.indexOf(cb);
      if (idx >= 0) viewChangeListeners.splice(idx, 1);
    };
  }

  function fireViewChange() {
    var id = activeView;
    viewChangeListeners.slice().forEach(function (cb) {
      try {
        cb(id);
      } catch (err) {
        console.error(err);
      }
    });
  }

  /**
   * Replace ALL views from a saved envelope (page load / restore).
   * Front → live canvas; views.back → viewStore; activeView = front.
   */
  function loadAllViewsFromEnvelope(envelope, getJSON) {
    if (getJSON) getJSONRef = getJSON;
    var front =
      envelope && envelope.canvas
        ? cloneFabricPayload(envelope.canvas)
        : emptyFabricCanvasObject();
    var back =
      envelope &&
      envelope.views &&
      envelope.views.back &&
      typeof envelope.views.back === "object"
        ? cloneFabricPayload(envelope.views.back)
        : emptyFabricCanvasObject();
    viewStore = { back: back };
    activeView = "front";
    return loadFabricPayload(front, getJSONRef).then(function () {
      forceTransparentBackground();
      refreshGarmentLayer();
      fireViewChange();
    });
  }

  function setActiveView(id) {
    if (id !== "front" && id !== "back") {
      return Promise.resolve({ ok: false, reason: "Unknown view." });
    }
    if (id === activeView) {
      return Promise.resolve({ ok: true, reason: "same" });
    }
    if (!fabricCanvas) {
      return Promise.resolve({ ok: false, reason: "Canvas is not ready." });
    }
    if (suppressCommit) {
      return Promise.resolve({ ok: false, reason: "Canvas is loading." });
    }
    if (
      VIEW_SWITCH_DURING_AI_PREVIEW === "blocked" &&
      aiCandidatesPending()
    ) {
      return Promise.resolve({
        ok: false,
        reason: "Choose an AI suggestion or edit the design first",
      });
    }

    var prevView = activeView;
    // Snapshot inactive store for restore (only the inactive key is populated).
    var savedInactive =
      prevView === "front"
        ? { back: viewStore.back ? cloneFabricPayload(viewStore.back) : emptyFabricCanvasObject() }
        : { front: viewStore.front ? cloneFabricPayload(viewStore.front) : emptyFabricCanvasObject() };

    var active = fabricCanvas.getActiveObject();
    if (active && active.isEditing && typeof active.exitEditing === "function") {
      active.exitEditing();
    }
    fabricCanvas.discardActiveObject();
    fabricCanvas.requestRenderAll();

    var liveSnap = snapshotLiveCanvas();
    var loadPayload;
    if (prevView === "front" && id === "back") {
      // Inactive store becomes front; load previous back (or empty).
      loadPayload = savedInactive.back || emptyFabricCanvasObject();
      viewStore = { front: liveSnap };
    } else {
      loadPayload = savedInactive.front || emptyFabricCanvasObject();
      viewStore = { back: liveSnap };
    }

    return loadFabricPayload(loadPayload, getJSONRef)
      .then(function () {
        if (lastLoadError) throw new Error(lastLoadError);
        forceTransparentBackground();
        activeView = id;
        refreshGarmentLayer();
        if (
          global.BlytzEditorTools &&
          typeof global.BlytzEditorTools.refreshLayers === "function"
        ) {
          global.BlytzEditorTools.refreshLayers();
        }
        if (global.BlytzEditorProps) {
          if (typeof global.BlytzEditorProps.closeSheet === "function") {
            global.BlytzEditorProps.closeSheet();
          }
          if (typeof global.BlytzEditorProps.syncFromSelection === "function") {
            global.BlytzEditorProps.syncFromSelection();
          }
        }
        var pill = document.getElementById("editor-props-pill");
        if (pill) {
          pill.hidden = true;
          pill.setAttribute("aria-expanded", "false");
        }
        fireViewChange();
        return { ok: true };
      })
      .catch(function (err) {
        viewStore = savedInactive;
        activeView = prevView;
        return loadFabricPayload(liveSnap, getJSONRef)
          .catch(function () {})
          .then(function () {
            forceTransparentBackground();
            refreshGarmentLayer();
            setToolFeedback(
              "Could not switch garment view. Your previous view was restored."
            );
            return {
              ok: false,
              reason: (err && err.message) || "View switch failed.",
            };
          });
      });
  }

  function getGarmentState() {
    return { template: garmentState.template, color: garmentState.color };
  }

  function setGarmentState(next) {
    next = next || {};
    var g = global.BlytzGarments;
    var template = next.template;
    var color = next.color;
    if (template != null) {
      if (!g || !g.garmentById || !g.garmentById(template)) {
        return { ok: false, reason: "Unknown garment template." };
      }
    }
    if (color != null) {
      var knownColor =
        g &&
        g.GARMENT_COLORS &&
        g.GARMENT_COLORS.some(function (c) {
          return c.id === color;
        });
      if (!knownColor) {
        return { ok: false, reason: "Unknown garment color." };
      }
    }
    var changed = false;
    if (template != null && template !== garmentState.template) {
      garmentState.template = template;
      changed = true;
    }
    if (color != null && color !== garmentState.color) {
      garmentState.color = color;
      changed = true;
    }
    if (!changed) return { ok: true, reason: "same" };
    refreshGarmentLayer();
    garmentChangeListeners.slice().forEach(function (cb) {
      try {
        cb(getGarmentState());
      } catch (err) {
        console.error(err);
      }
    });
    return { ok: true };
  }

  function onGarmentChange(cb) {
    if (typeof cb === "function") garmentChangeListeners.push(cb);
    return function unsubscribe() {
      var idx = garmentChangeListeners.indexOf(cb);
      if (idx >= 0) garmentChangeListeners.splice(idx, 1);
    };
  }

  function initGarmentFromPage() {
    var page = document.querySelector("[data-editor-page]");
    if (!page) return;
    var g = global.BlytzGarments;
    var t = page.getAttribute("data-garment-template") || "tee";
    var c = page.getAttribute("data-garment-color") || "white";
    // Unknown legacy values → tee / white in the editor ONLY (do not rewrite stored until save).
    if (!g || !g.garmentById || !g.garmentById(t)) t = "tee";
    if (g && g.colorById) {
      var col = g.colorById(c);
      var known =
        g.GARMENT_COLORS &&
        g.GARMENT_COLORS.some(function (x) {
          return x.id === c;
        });
      if (!known && String(c).charAt(0) !== "#") c = "white";
      else if (col && col.id) c = col.id === "grey" ? "gray" : col.id;
    } else {
      c = "white";
    }
    garmentState = { template: t, color: c };
    refreshGarmentLayer();
  }

  function sanitizeCanvasDom() {
    if (!fabricCanvas) return;
    var lower = fabricCanvas.lowerCanvasEl;
    var upper = fabricCanvas.upperCanvasEl;
    [lower, upper].forEach(function (el) {
      if (!el) return;
      el.classList.remove(
        "bg-canvas",
        "border",
        "border-border",
        "shadow-sm",
        "rounded-md",
        "max-w-full",
        "block"
      );
      el.style.backgroundColor = "transparent";
    });
    if (lower) {
      lower.style.position = "absolute";
      lower.style.left = "0px";
      lower.style.top = "0px";
    }
  }

  /**
   * Size the displayed artboard from a height-locked workspace (#editor-root),
   * not from #editor-canvas-host (which previously grew with AI panel content).
   * Logical canvas remains LOGICAL_SIZE; object bounds never drive this value.
   */
  function availableDisplaySize() {
    var root = document.getElementById("editor-root");
    var host = document.getElementById("editor-canvas-host");
    var box = root || host;
    var availW = box ? box.clientWidth : window.innerWidth - 32;
    var availH = box ? box.clientHeight : window.innerHeight - 160;

    // Prefer host padding when measuring inside the canvas column.
    var padTarget = host || box;
    if (padTarget && typeof global.getComputedStyle === "function") {
      var cs = global.getComputedStyle(padTarget);
      availW -=
        (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
      availH -=
        (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    }
    // Caption under the wrap consumes vertical space inside the host.
    if (host && host.querySelector(":scope > p")) {
      availH = Math.max(180, availH - 40);
    }
    // Cap by root height so AI-driven page growth cannot enlarge the artboard.
    if (root && root.clientHeight > 0) {
      availH = Math.min(availH, root.clientHeight - 48);
    }
    var side = Math.min(availW, availH, LOGICAL_SIZE);
    return Math.max(220, Math.floor(side));
  }

  function applyResponsiveSize() {
    if (!fabricCanvas) return;
    var wrap = document.getElementById("editor-canvas-wrap");
    if (!wrap) return;
    var css = availableDisplaySize();
    // Skip no-op updates to avoid ResizeObserver feedback loops.
    if (css === lastAppliedDisplaySize && wrap.style.width === css + "px") {
      return;
    }
    lastAppliedDisplaySize = css;
    // Logical coordinates stay 800×800. CSS size is display-only; never rewrite object coords.
    fabricCanvas.setZoom(1);
    fabricCanvas.setDimensions(
      { width: LOGICAL_SIZE, height: LOGICAL_SIZE },
      { backstoreOnly: true }
    );
    // content-box: wrap content == Fabric CSS size; border sits outside so pointer maps stay aligned.
    wrap.style.boxSizing = "content-box";
    wrap.style.width = css + "px";
    wrap.style.height = css + "px";
    fabricCanvas.setDimensions({ width: css, height: css }, { cssOnly: true });
    sanitizeCanvasDom();
    fabricCanvas.requestRenderAll();
  }

  function scheduleResponsiveSize() {
    if (resizeApplyScheduled) return;
    resizeApplyScheduled = true;
    var run = function () {
      resizeApplyScheduled = false;
      applyResponsiveSize();
    };
    if (typeof global.requestAnimationFrame === "function") {
      global.requestAnimationFrame(run);
    } else {
      global.setTimeout(run, 0);
    }
  }

  function applyTouchFriendlyHandles() {
    if (touchHandlesApplied) return;
    var fabric = fabricNS();
    if (!fabric || !fabric.FabricObject || !fabric.FabricObject.ownDefaults) return;
    var coarse =
      typeof global.matchMedia === "function" &&
      global.matchMedia("(pointer: coarse)").matches;
    if (!coarse) return;
    touchHandlesApplied = true;
    fabric.FabricObject.ownDefaults.cornerSize = 14;
    fabric.FabricObject.ownDefaults.touchCornerSize = 28;
    fabric.FabricObject.ownDefaults.cornerStyle = "circle";
  }

  function syncMultiSelectUi() {
    document.querySelectorAll("[data-editor-action='multi-select']").forEach(function (btn) {
      btn.setAttribute("aria-pressed", multiSelectMode ? "true" : "false");
      btn.classList.toggle("is-active", multiSelectMode);
    });
    document.querySelectorAll("[data-editor-action='select']").forEach(function (btn) {
      btn.setAttribute("aria-pressed", multiSelectMode ? "false" : "true");
      btn.classList.toggle("is-active", !multiSelectMode);
    });
  }

  function setMultiSelectMode(on) {
    multiSelectMode = !!on;
    if (fabricCanvas) {
      // Touch multi-select workaround verified against Fabric 6.6.1 only.
      // Public Fabric 6 API: selectionKey may be a key name or array of key names.
      // When multi-select mode is on, pointer events get e.blytzMultiSelect = true
      // so taps toggle membership like Shift+click.
      fabricCanvas.selectionKey = multiSelectMode
        ? ["shiftKey", "blytzMultiSelect"]
        : "shiftKey";
    }
    syncMultiSelectUi();
    setToolFeedback(
      multiSelectMode
        ? "Multi-select on — tap objects to add or remove."
        : "Select tool"
    );
  }

  function wireMultiSelectPointer() {
    if (multiSelectPointerWired) return;
    multiSelectPointerWired = true;
    var mark = function (e) {
      if (multiSelectMode) {
        try {
          e.blytzMultiSelect = true;
        } catch (err) {
          /* ignore */
        }
      }
    };
    // Capture on wrap so Fabric's handlers see the flag.
    var wrap = document.getElementById("editor-canvas-wrap");
    if (!wrap) return;
    ["pointerdown", "mousedown", "touchstart"].forEach(function (type) {
      wrap.addEventListener(type, mark, true);
    });
  }

  function wireContextMenuSuppression() {
    if (contextMenuWired) return;
    var wrap = document.getElementById("editor-canvas-wrap");
    if (!wrap) return;
    contextMenuWired = true;
    // Casual-copy deterrent only (not DRM): block browser context menu and
    // native image drag on the artboard wrapper. No custom menu yet.
    wrap.addEventListener("contextmenu", function (e) {
      e.preventDefault();
    });
    wrap.addEventListener("dragstart", function (e) {
      e.preventDefault();
    });
  }

  function bindCanvasEvents(getJSON) {
    if (!fabricCanvas || eventsBound) return;
    eventsBound = true;
    getJSONRef = getJSON;

    // Native drag / scale / rotate: one object:modified per gesture → one commit.
    fabricCanvas.on("object:modified", function () {
      if (Date.now() < suppressModifiedUntil) return;
      notifyCommitted(getJSON, "object:modified");
    });

    // Commit on editing exit only when the string actually changed.
    fabricCanvas.on("text:editing:entered", function (opt) {
      var t = opt && opt.target;
      textAtEditStart = t && typeof t.text === "string" ? t.text : null;
      textEditDirty = false;
    });
    fabricCanvas.on("text:changed", function () {
      textEditDirty = true;
    });
    fabricCanvas.on("text:editing:exited", function (opt) {
      var t = opt && opt.target;
      var start = textAtEditStart;
      textAtEditStart = null;
      var changed =
        !!t &&
        typeof t.text === "string" &&
        start !== null &&
        t.text !== start;
      textEditDirty = false;
      if (!changed) return;
      // Fabric often also fires object:modified after exit — suppress briefly.
      suppressModifiedUntil = Date.now() + 200;
      notifyCommitted(getJSON, "text:editing:exited");
    });

    // Selection changes must never commit.
    // object:added / object:removed intentionally do not notify; mutations go
    // through commitEdit (or loadFabricPayload with suppressCommit).
  }

  function ensureCanvas(getJSON) {
    if (getJSON) getJSONRef = getJSON;
    if (fabricCanvas) return fabricCanvas;
    var fabric = fabricNS();
    if (!fabric || !fabric.Canvas) {
      console.error("Fabric.js is not loaded");
      return null;
    }
    var el = document.getElementById("blytz-fabric-canvas");
    if (!el) {
      console.error("Missing #blytz-fabric-canvas");
      return null;
    }
    applyTouchFriendlyHandles();
    fabricCanvas = new fabric.Canvas(el, {
      preserveObjectStacking: true,
      selection: true,
      backgroundColor: "",
      selectionKey: "shiftKey",
    });
    fabricCanvas.setDimensions({ width: LOGICAL_SIZE, height: LOGICAL_SIZE });
    sanitizeCanvasDom();
    forceTransparentBackground();
    bindCanvasEvents(getJSONRef);
    applyResponsiveSize();
    wireMultiSelectPointer();
    wireContextMenuSuppression();
    syncMultiSelectUi();
    initGarmentFromPage();
    if (typeof ResizeObserver !== "undefined" && !resizeObserver) {
      // Observe the height-locked workspace root, not the wrap (avoids feedback).
      var workspace = document.getElementById("editor-root");
      if (workspace) {
        resizeObserver = new ResizeObserver(function () {
          scheduleResponsiveSize();
        });
        resizeObserver.observe(workspace);
      }
    }
    global.addEventListener("resize", scheduleResponsiveSize);
    var root = document.getElementById("editor-root");
    if (root) root.dataset.loaded = "1";
    return fabricCanvas;
  }

  function loadFabricPayload(payload, getJSON) {
    if (getJSON) getJSONRef = getJSON;
    var canvas = ensureCanvas(getJSONRef);
    if (!canvas) {
      return Promise.reject(new Error("Canvas unavailable"));
    }
    var gen = ++loadGeneration;
    suppressCommit = true;
    lastLoadError = "";
    return canvas
      .loadFromJSON(payload || emptyFabricCanvasObject())
      .then(function () {
        if (gen !== loadGeneration) return;
        // Assign missing/duplicate blytzIds with commits suppressed (not a user edit).
        ensureBlytzIds(canvas);
        // Old designs may serialize background "#ffffff"; force transparent so garment shows.
        forceTransparentBackground();
        applyResponsiveSize();
        canvas.discardActiveObject();
        canvas.requestRenderAll();
      })
      .catch(function (err) {
        console.error("Failed to load canvas JSON", err);
        lastLoadError =
          "Could not load this design onto the canvas. Saving is blocked so the original is not overwritten. Reload or go back.";
        canvas.clear();
        forceTransparentBackground();
        canvas.requestRenderAll();
        throw err;
      })
      .finally(function () {
        if (gen === loadGeneration) suppressCommit = false;
      });
  }

  function persistAllowed() {
    var editor = global.BlytzEditor;
    return !!(editor && typeof editor.canPersist === "function" && editor.canPersist());
  }

  function addText(getJSON) {
    if (!persistAllowed()) {
      setToolFeedback(
        (global.BlytzEditor && global.BlytzEditor.getPersistBlockReason()) ||
          "Editing is unavailable until the design finishes loading."
      );
      return;
    }
    var fabric = fabricNS();
    var canvas = ensureCanvas(getJSON);
    if (!canvas || !fabric) return;
    var entered = false;
    commitEdit(
      "add-text",
      function () {
        var placeholder = "Your text";
        var text = new fabric.IText(placeholder, {
          fontSize: 48,
          fill: defaultContrastFill(),
          fontFamily: ALLOWED_FONTS[0],
          originX: "left",
          originY: "top",
        });
        assignBlytzId(text);
        assignBlytzName(text, "Text");
        canvas.add(text);
        if (typeof text.initDimensions === "function") text.initDimensions();
        text.setCoords();
        var w = text.getScaledWidth();
        var h = text.getScaledHeight();
        // Visually center using left/top origin (same origin family as AI mocks).
        text.set({
          left: LOGICAL_SIZE / 2 - w / 2,
          top: LOGICAL_SIZE / 2 - h / 2,
        });
        canvas.setActiveObject(text);
        canvas.requestRenderAll();
        setToolFeedback("Text added.");
        return true;
      },
      getJSON
    );
    // Enter editing after the insert commit so typing can produce a second commit.
    var active = canvas.getActiveObject();
    if (active && typeof active.enterEditing === "function") {
      active.enterEditing();
      if (typeof active.selectAll === "function") active.selectAll();
      canvas.requestRenderAll();
      entered = true;
    }
    return entered;
  }

  function deleteSelection(getJSON) {
    if (!persistAllowed()) {
      setToolFeedback(
        (global.BlytzEditor && global.BlytzEditor.getPersistBlockReason()) ||
          "Editing is unavailable until the design finishes loading."
      );
      return;
    }
    var canvas = ensureCanvas(getJSON);
    if (!canvas) return;
    var active = canvas.getActiveObjects();
    if (!active || !active.length) {
      setToolFeedback("Select an object to delete.");
      return;
    }
    commitEdit(
      "delete",
      function () {
        active.forEach(function (obj) {
          canvas.remove(obj);
        });
        canvas.discardActiveObject();
        canvas.requestRenderAll();
        setToolFeedback("Deleted.");
        return true;
      },
      getJSON
    );
  }

  /**
   * UTF-8 byte length of the full persist envelope (both views once Task 12 lands).
   * Image budget / 100% probe must use this helper so size policy stays in one place.
   */
  function measureEnvelopeBytes() {
    return utf8ByteLength(JSON.stringify(buildEnvelopeFromCanvas()));
  }

  function setImagePickerBusy(busy) {
    var btn = document.querySelector("[data-panel-choose-image]");
    if (btn) {
      btn.disabled = !!busy;
      if (busy) btn.setAttribute("aria-busy", "true");
      else btn.removeAttribute("aria-busy");
    }
  }

  function fileToDataURL(file) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("read"));
      };
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  function decodeImageFile(file) {
    // Animated WebP is flattened to its first frame (createImageBitmap / Image decode).
    if (typeof createImageBitmap === "function") {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(
        function () {
          return decodeImageFileViaElement(file);
        }
      );
    }
    return decodeImageFileViaElement(file);
  }

  function decodeImageFileViaElement(file) {
    return fileToDataURL(file).then(function (url) {
      return new Promise(function (resolve, reject) {
        var img = new Image();
        img.onload = function () {
          resolve(img);
        };
        img.onerror = function () {
          reject(new Error("decode"));
        };
        img.src = url;
      });
    });
  }

  function canvasHasAlpha(ctx, w, h) {
    try {
      var data = ctx.getImageData(0, 0, w, h).data;
      for (var i = 3; i < data.length; i += 4) {
        if (data[i] < 255) return true;
      }
    } catch (err) {
      return true;
    }
    return false;
  }

  function blobToDataURL(blob) {
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onerror = function () {
        reject(new Error("read-blob"));
      };
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.readAsDataURL(blob);
    });
  }

  function encodeCanvas(canvasEl, mime, quality) {
    return new Promise(function (resolve) {
      if (canvasEl.toBlob) {
        canvasEl.toBlob(
          function (blob) {
            resolve(blob || null);
          },
          mime,
          quality
        );
      } else {
        try {
          var url = canvasEl.toDataURL(mime, quality);
          var bin = atob(url.split(",")[1] || "");
          var arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          resolve(new Blob([arr], { type: mime }));
        } catch (err) {
          resolve(null);
        }
      }
    });
  }

  /**
   * Downscale / re-encode pipeline. Returns {ok, dataUrl, width, height, mime, bytes, keptOriginal}.
   */
  function processImageForInsert(file, bitmap) {
    var srcW = bitmap.width || 0;
    var srcH = bitmap.height || 0;
    if (!(srcW > 0) || !(srcH > 0)) {
      return Promise.resolve({ ok: false, reason: "corrupt" });
    }
    if (srcW * srcH > IMAGE_MAX_PIXELS) {
      return Promise.resolve({ ok: false, reason: "pixels" });
    }
    var maxEdge = Math.max(srcW, srcH);
    if (maxEdge <= IMAGE_MAX_EDGE && file.size <= IMAGE_TARGET_BYTES) {
      return fileToDataURL(file).then(function (dataUrl) {
        return {
          ok: true,
          dataUrl: dataUrl,
          width: srcW,
          height: srcH,
          mime: file.type || "image/png",
          bytes: file.size,
          keptOriginal: true,
        };
      });
    }

    function drawAt(edge) {
      var scale = Math.min(1, edge / maxEdge);
      var w = Math.max(1, Math.round(srcW * scale));
      var h = Math.max(1, Math.round(srcH * scale));
      var el = document.createElement("canvas");
      el.width = w;
      el.height = h;
      var ctx = el.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, w, h);
      return { el: el, w: w, h: h, hasAlpha: canvasHasAlpha(ctx, w, h) };
    }

    function tryEncode(drawn) {
      var order = [];
      // Prefer webp; fall back based on alpha if browser returns a different type.
      order.push({ mime: "image/webp", qualities: IMAGE_QUALITY_STEPS.slice() });
      if (drawn.hasAlpha) {
        order.push({ mime: "image/png", qualities: [undefined] });
      } else {
        order.push({ mime: "image/jpeg", qualities: IMAGE_QUALITY_STEPS.slice() });
      }
      var chain = Promise.resolve(null);
      order.forEach(function (entry) {
        entry.qualities.forEach(function (q) {
          chain = chain.then(function (best) {
            if (best) return best;
            return encodeCanvas(drawn.el, entry.mime, q).then(function (blob) {
              if (!blob) return null;
              var outType = blob.type || entry.mime;
              if (entry.mime === "image/webp" && outType.indexOf("webp") === -1) {
                return null;
              }
              if (blob.size <= IMAGE_TARGET_BYTES) {
                return blobToDataURL(blob).then(function (dataUrl) {
                  return {
                    ok: true,
                    dataUrl: dataUrl,
                    width: drawn.w,
                    height: drawn.h,
                    mime: outType,
                    bytes: blob.size,
                    keptOriginal: false,
                  };
                });
              }
              return null;
            });
          });
        });
      });
      return chain;
    }

    var edgeChain = Promise.resolve(null);
    IMAGE_EDGE_STEPS.forEach(function (edge) {
      edgeChain = edgeChain.then(function (best) {
        if (best) return best;
        if (edge > maxEdge && edge !== IMAGE_EDGE_STEPS[0]) {
          // Skip upsizing; still allow first step when already large.
        }
        var drawn = drawAt(Math.min(edge, maxEdge));
        return tryEncode(drawn);
      });
    });
    return edgeChain.then(function (result) {
      if (result) return result;
      return { ok: false, reason: "too-detailed" };
    });
  }

  function addImageFromFile(file, getJSON) {
    if (!persistAllowed()) {
      setToolFeedback(
        (global.BlytzEditor && global.BlytzEditor.getPersistBlockReason()) ||
          "Editing is unavailable until the design finishes loading."
      );
      return Promise.resolve({ ok: false, reason: "not-ready" });
    }
    var fabric = fabricNS();
    var canvas = ensureCanvas(getJSON);
    if (!canvas || !fabric) {
      return Promise.resolve({ ok: false, reason: "no-canvas" });
    }
    // Cancelled file picker: silent no-op, no commit.
    if (!file) {
      return Promise.resolve({ ok: false, reason: "cancelled" });
    }
    if (!ALLOWED_IMAGE_TYPES[file.type]) {
      setToolFeedback("Image must be PNG, JPG, or WebP.");
      return Promise.resolve({ ok: false, reason: "type" });
    }
    if (file.size > IMAGE_INPUT_LIMIT_BYTES) {
      setToolFeedback(
        "Image must be " +
          Math.round(IMAGE_INPUT_LIMIT_BYTES / (1024 * 1024)) +
          " MB or smaller."
      );
      return Promise.resolve({ ok: false, reason: "size" });
    }

    setImagePickerBusy(true);
    setToolFeedback("Processing image...");

    return decodeImageFile(file)
      .catch(function () {
        return Promise.reject(new Error("decode"));
      })
      .then(function (bitmap) {
        return processImageForInsert(file, bitmap).then(function (processed) {
          if (bitmap && typeof bitmap.close === "function") {
            try {
              bitmap.close();
            } catch (err) {
              /* ignore */
            }
          }
          return processed;
        });
      })
      .then(function (processed) {
        if (!processed || !processed.ok) {
          if (processed && processed.reason === "pixels") {
            setToolFeedback(
              "This image is too large (too many pixels) to add. Try a smaller image."
            );
          } else if (processed && processed.reason === "too-detailed") {
            setToolFeedback(
              "This image is too detailed to add. Try a smaller image."
            );
          } else {
            setToolFeedback(
              "That image file could not be decoded. Try a different PNG, JPG, or WebP."
            );
          }
          return { ok: false, reason: (processed && processed.reason) || "corrupt" };
        }
        var fromURL =
          fabric.FabricImage && fabric.FabricImage.fromURL
            ? fabric.FabricImage.fromURL.bind(fabric.FabricImage)
            : fabric.Image && fabric.Image.fromURL
              ? fabric.Image.fromURL.bind(fabric.Image)
              : null;
        if (!fromURL) {
          setToolFeedback("Image import is unavailable.");
          return { ok: false, reason: "api" };
        }
        return fromURL(processed.dataUrl, { crossOrigin: "anonymous" }).then(
          function (img) {
            if (!img || !(img.width > 0) || !(img.height > 0)) {
              setToolFeedback(
                "That image file could not be decoded. Try a different PNG, JPG, or WebP."
              );
              return { ok: false, reason: "corrupt" };
            }
            var inserted = commitEdit(
              "add-image",
              function () {
                var displayMax = 400;
                var scale = Math.min(
                  1,
                  displayMax / Math.max(img.width || 1, img.height || 1)
                );
                var pos = nextInsertCenter();
                img.set({
                  left: pos.left,
                  top: pos.top,
                  originX: "center",
                  originY: "center",
                  scaleX: scale,
                  scaleY: scale,
                });
                assignBlytzId(img);
                assignBlytzName(img, "Image");
                canvas.add(img);
                canvas.setActiveObject(img);
                canvas.requestRenderAll();
                var bytes = measureEnvelopeBytes();
                var budget = Math.floor(
                  MAX_CANVAS_JSON_BYTES * IMAGE_INSERT_BUDGET_RATIO
                );
                if (bytes > budget) {
                  canvas.remove(img);
                  canvas.requestRenderAll();
                  setToolFeedback(
                    "Not enough room left in this design to add this image. Try a smaller image or remove one."
                  );
                  return false;
                }
                if (bytes > MAX_CANVAS_JSON_BYTES) {
                  canvas.remove(img);
                  canvas.requestRenderAll();
                  setToolFeedback(
                    "Design would exceed the save size limit after adding this image. Try a smaller file or fewer images."
                  );
                  return false;
                }
                setToolFeedback("Image added.");
                return true;
              },
              getJSON
            );
            return {
              ok: !!inserted,
              reason: inserted ? "ok" : "budget",
              processed: processed,
            };
          }
        );
      })
      .catch(function (err) {
        if (err && err.message === "decode") {
          setToolFeedback(
            "That image file could not be decoded. Try a different PNG, JPG, or WebP."
          );
          return { ok: false, reason: "corrupt" };
        }
        setToolFeedback("Could not read that image file.");
        return { ok: false, reason: "read" };
      })
      .finally(function () {
        setImagePickerBusy(false);
      });
  }

  function triggerImagePicker() {
    var fileInput = document.querySelector("[data-editor-image-input]");
    if (fileInput) fileInput.click();
  }

  /**
   * Insert a Fabric object built by factory({left, top}) via commitEdit.
   * factory receives cascade center; must return a fabric object (not a Group).
   * Optional defaultName sets blytzName when the factory did not.
   */
  function insertElement(label, factory, getJSON, defaultName) {
    if (!persistAllowed()) {
      setToolFeedback(
        (global.BlytzEditor && global.BlytzEditor.getPersistBlockReason()) ||
          "Editing is unavailable until the design finishes loading."
      );
      return false;
    }
    var canvas = ensureCanvas(getJSON);
    if (!canvas) return false;
    return commitEdit(
      label || "insert-element",
      function () {
        var pos = nextInsertCenter();
        var obj = factory(pos);
        if (!obj) return false;
        assignBlytzId(obj);
        if (defaultName) assignBlytzName(obj, defaultName);
        canvas.add(obj);
        canvas.setActiveObject(obj);
        canvas.requestRenderAll();
                if (measureEnvelopeBytes() > MAX_CANVAS_JSON_BYTES) {
          canvas.remove(obj);
          canvas.requestRenderAll();
          setToolFeedback(
            "Design would exceed the save size limit. Remove something and try again."
          );
          return false;
        }
        return true;
      },
      getJSON
    );
  }

  /**
   * Stacking reorder via Fabric 6.6.1 canvas methods.
   * bringObjectForward/sendObjectBackwards with intersecting=false → one list step.
   */
  function reorderActive(action, getJSON) {
    if (!persistAllowed()) return false;
    var canvas = ensureCanvas(getJSON);
    if (!canvas) return false;
    var obj = canvas.getActiveObject();
    if (!obj || isActiveSelection(obj)) return false;
    return commitEdit(
      "reorder-" + action,
      function () {
        var moved = false;
        if (action === "forward") {
          moved = !!canvas.bringObjectForward(obj, false);
        } else if (action === "backward") {
          moved = !!canvas.sendObjectBackwards(obj, false);
        } else if (action === "front") {
          moved = !!canvas.bringObjectToFront(obj);
        } else if (action === "back") {
          moved = !!canvas.sendObjectToBack(obj);
        }
        if (!moved) return false;
        canvas.requestRenderAll();
        return true;
      },
      getJSON
    );
  }

  function canReorderActive(action) {
    var canvas = fabricCanvas;
    if (!canvas) return false;
    var obj = canvas.getActiveObject();
    if (!obj || isActiveSelection(obj)) return false;
    var idx = canvas.getObjects().indexOf(obj);
    if (idx < 0) return false;
    var last = canvas.getObjects().length - 1;
    if (action === "forward" || action === "front") return idx < last;
    if (action === "backward" || action === "back") return idx > 0;
    return false;
  }

  function wireTools(getJSON) {
    if (toolsWired) return;
    toolsWired = true;
    getJSONRef = getJSON;

    document.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-editor-action]");
      if (!btn || btn.getAttribute("aria-disabled") === "true" || btn.disabled) {
        return;
      }
      var action = btn.getAttribute("data-editor-action");
      if (action === "add-text") {
        e.preventDefault();
        addText(getJSON);
      } else if (action === "delete") {
        e.preventDefault();
        deleteSelection(getJSON);
      } else if (action === "select") {
        e.preventDefault();
        setMultiSelectMode(false);
      } else if (action === "multi-select") {
        e.preventDefault();
        setMultiSelectMode(!multiSelectMode);
      }
      // add-image / elements are handled by editor_tools.js (panel open).
    });

    document.querySelectorAll("[data-editor-image-input]").forEach(function (fileInput) {
      fileInput.addEventListener("change", function () {
        var file = fileInput.files && fileInput.files[0];
        // Cancelled picker → no file → silent.
        if (!file) {
          fileInput.value = "";
          return;
        }
        addImageFromFile(file, getJSON).then(function (result) {
          if (
            result &&
            result.ok &&
            global.BlytzEditorTools &&
            typeof global.BlytzEditorTools.onSuccessfulInsert === "function"
          ) {
            global.BlytzEditorTools.onSuccessfulInsert("upload");
          }
        });
        fileInput.value = "";
      });
    });

    document.addEventListener("keydown", function (e) {
      if (!fabricCanvas) return;
      var target = e.target;
      var tag = (target && target.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (target && target.isContentEditable) return;
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      var active = fabricCanvas.getActiveObject();
      if (!active) return;
      if (active.isEditing) return;
      e.preventDefault();
      deleteSelection(getJSON);
    });

    syncMultiSelectUi();
    wireContextMenuSuppression();
  }

  var api = {
    LOGICAL_SIZE: LOGICAL_SIZE,
    SCHEMA_VERSION: SCHEMA_VERSION,
    fabricVersionOk: fabricVersionOk,
    MAX_CANVAS_JSON_BYTES: MAX_CANVAS_JSON_BYTES,
    IMAGE_INSERT_BUDGET_RATIO: IMAGE_INSERT_BUDGET_RATIO,
    IMAGE_INPUT_LIMIT_BYTES: IMAGE_INPUT_LIMIT_BYTES,
    IMAGE_MAX_EDGE: IMAGE_MAX_EDGE,
    IMAGE_TARGET_BYTES: IMAGE_TARGET_BYTES,
    IMAGE_QUALITY_STEPS: IMAGE_QUALITY_STEPS,
    IMAGE_EDGE_STEPS: IMAGE_EDGE_STEPS,
    IMAGE_MAX_PIXELS: IMAGE_MAX_PIXELS,
    measureEnvelopeBytes: measureEnvelopeBytes,
    ALLOWED_FONTS: ALLOWED_FONTS,
    COLOR_PRESETS: COLOR_PRESETS,
    PROP_LIMITS: PROP_LIMITS,
    ALLOWED_IMAGE_TYPES: ALLOWED_IMAGE_TYPES,
    DEFAULT_SHAPE_FILL: DEFAULT_SHAPE_FILL,
    DEFAULT_SHAPE_MAX_EDGE: DEFAULT_SHAPE_MAX_EDGE,
    ALLOWED_OBJECT_TYPES: ALLOWED_OBJECT_TYPES,
    SERIALIZE_PROPS: SERIALIZE_PROPS,
    utf8ByteLength: utf8ByteLength,
    parseInput: parseInput,
    scanCanvasPayload: scanCanvasPayload,
    validateObjectsAllowlist: validateObjectsAllowlist,
    isLegacyEmpty: isLegacyEmpty,
    isBlytzV1: isBlytzV1,
    isUnsupportedLegacy: isUnsupportedLegacy,
    emptyEnvelope: emptyEnvelope,
    emptyFabricCanvasObject: emptyFabricCanvasObject,
    ensureCanvas: ensureCanvas,
    loadFabricPayload: loadFabricPayload,
    loadAllViewsFromEnvelope: loadAllViewsFromEnvelope,
    buildEnvelopeFromCanvas: buildEnvelopeFromCanvas,
    getActiveCanvasJSON: getActiveCanvasJSON,
    getActiveView: getActiveView,
    setActiveView: setActiveView,
    onViewChange: onViewChange,
    getGarmentState: getGarmentState,
    setGarmentState: setGarmentState,
    onGarmentChange: onGarmentChange,
    refreshGarmentLayer: refreshGarmentLayer,
    forceTransparentBackground: forceTransparentBackground,
    defaultContrastFill: defaultContrastFill,
    initGarmentFromPage: initGarmentFromPage,
    aiCandidatesPending: aiCandidatesPending,
    VIEW_SWITCH_DURING_AI_PREVIEW: VIEW_SWITCH_DURING_AI_PREVIEW,
    applyResponsiveSize: applyResponsiveSize,
    setToolFeedback: setToolFeedback,
    setMessageSink: setMessageSink,
    commitEdit: commitEdit,
    runSilent: runSilent,
    addText: addText,
    addImageFromFile: addImageFromFile,
    insertElement: insertElement,
    deleteSelection: deleteSelection,
    reorderActive: reorderActive,
    canReorderActive: canReorderActive,
    assignBlytzName: assignBlytzName,
    typeKey: typeKey,
    isActiveSelection: isActiveSelection,
    triggerImagePicker: triggerImagePicker,
    nextInsertCenter: nextInsertCenter,
    getLastLoadError: function () {
      return lastLoadError;
    },
    wireTools: wireTools,
    getFabricCanvas: function () {
      return fabricCanvas;
    },
    getMultiSelectMode: function () {
      return multiSelectMode;
    },
    setMultiSelectMode: setMultiSelectMode,
  };

  global.BlytzCanvas = api;
})(window);
