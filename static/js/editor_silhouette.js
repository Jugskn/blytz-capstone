/**
 * Blytz Capstone — garment silhouette: mask, containment and mock-up wrap.
 * Vanilla JS; attaches global BlytzSilhouette (no modules).
 *
 * What it does
 *  1. Reads the real garment outline from the garment SVG (<clipPath id="…-clip">).
 *  2. Editor: clips the artwork to that outline (visual only) and, while the
 *     user is dragging / resizing by hand, stops the object at the edge.
 *  3. Large objects may extend a little past the side seams ("wrap zone");
 *     the overflow is hidden in the editor and wraps around the garment in
 *     the mock-up / preview images.
 *  4. Mock-up only: warps the flat artwork like it curves around the body.
 *     The stored design (canvas JSON) is never warped.
 *
 * Guarantee: this file NEVER changes an object's size, scale, angle or position
 * by itself. Switching Front/Back or changing garment, loading a design,
 * undo/redo and AI results leave every object exactly as it was. The only time
 * an object is held back is during a live manual drag / resize
 * (set ENFORCE_EDGE_STOP = false to turn even that off and rely on clipping).
 *
 * Depends on: window.BlytzGarments (editor_garments.js), window.BlytzCanvas
 * and window.fabric (editor_canvas.js). Everything degrades to "no silhouette"
 * (old rectangle behaviour) if the outline cannot be read.
 */
(function (global) {
  "use strict";

  var SIZE = 800;
  /** Cylinder strength. Smaller = gentler wrap. Centre of the body is never distorted. */
  var WRAP_C = 0.8;
  /** Extra width (as a share of the half-width) a large object may spill past the side seam. */
  var WRAP_OVERFLOW = Math.asin(WRAP_C) / WRAP_C - 1; // ≈ 0.159
  /** An object counts as "large" when it fills this share of the body width. */
  var LARGE_RATIO = 0.85;
  var EDGE_SAMPLES = 12;
  var SMOOTH_ROWS = 8;
  /** Hold an object at the edge while the user drags/resizes it by hand. */
  var ENFORCE_EDGE_STOP = true;
  var CLIP_ID = "bz-silhouette-clip";
  var DEFS_ID = "bz-silhouette-defs";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var TRANSFORM_KEYS = [
    "left",
    "top",
    "scaleX",
    "scaleY",
    "angle",
    "skewX",
    "skewY",
    "flipX",
    "flipY",
  ];

  var loadPromises = Object.create(null);
  var current = null; // silhouette for the active garment + view
  var syncToken = 0;
  var records = new WeakMap(); // fabric object -> { state, v }

  /* ======================================================================
   * Pure core (no DOM) — unit-testable in Node
   * ==================================================================== */

  function clamp(n, lo, hi) {
    return Math.max(lo, Math.min(hi, n));
  }

  function maskAt(mask, x, y) {
    var xi = Math.round(x);
    var yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= SIZE || yi >= SIZE) return false;
    return mask[yi * SIZE + xi] === 1;
  }

  /** The run of filled pixels in row y that contains cx0 (or the nearest run). */
  function centralInterval(mask, y, cx0) {
    var base = y * SIZE;
    var best = null;
    var bestDist = Infinity;
    var x = 0;
    while (x < SIZE) {
      if (mask[base + x] === 1) {
        var a = x;
        while (x + 1 < SIZE && mask[base + x + 1] === 1) x++;
        var b = x;
        var dist =
          a <= cx0 && cx0 <= b ? 0 : Math.min(Math.abs(a - cx0), Math.abs(b - cx0));
        if (dist < bestDist) {
          bestDist = dist;
          best = [a, b];
        }
        if (dist === 0) break;
      }
      x++;
    }
    return best;
  }

  function median(values) {
    var s = values.slice().sort(function (p, q) {
      return p - q;
    });
    var n = s.length;
    if (!n) return 0;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  /**
   * Per-row "body" geometry: centre + half-width of the central run, capped at the
   * torso width so sleeves do not stretch the wrap, then smoothed.
   */
  function buildSilhouette(mask) {
    var rawCx = new Float32Array(SIZE);
    var rawHw = new Float32Array(SIZE);
    var ok = new Uint8Array(SIZE);
    var first = -1;
    var last = -1;
    var y;
    for (y = 0; y < SIZE; y++) {
      var iv = centralInterval(mask, y, SIZE / 2);
      if (!iv) continue;
      rawCx[y] = (iv[0] + iv[1]) / 2;
      rawHw[y] = (iv[1] - iv[0]) / 2;
      ok[y] = 1;
      if (first < 0) first = y;
      last = y;
    }
    if (first < 0) return null;

    var span = last - first;
    var sample = [];
    for (y = first; y <= last; y++) {
      if (ok[y] && y >= first + 0.6 * span && y <= first + 0.85 * span) {
        sample.push(rawHw[y]);
      }
    }
    var cap = median(sample);
    if (!(cap > 0)) cap = median(Array.prototype.slice.call(rawHw, first, last + 1));

    var act = new Float32Array(SIZE);
    for (y = first; y <= last; y++) act[y] = Math.min(rawHw[y], cap);

    var cx = new Float32Array(SIZE);
    var hw = new Float32Array(SIZE);
    for (y = first; y <= last; y++) {
      var lo = Math.max(first, y - SMOOTH_ROWS);
      var hi = Math.min(last, y + SMOOTH_ROWS);
      var sumHw = 0;
      var sumCx = 0;
      var n = 0;
      for (var k = lo; k <= hi; k++) {
        sumHw += act[k];
        sumCx += rawCx[k];
        n++;
      }
      cx[y] = sumCx / n;
      hw[y] = Math.min(sumHw / n, act[y]);
    }

    return {
      mask: mask,
      rows: { cx: cx, hw: hw, ok: ok, first: first, last: last, cap: cap },
    };
  }

  /**
   * Cylindrical wrap of an 800×800 RGBA bitmap (Uint8ClampedArray / Uint8Array).
   * Row by row: x → x_src = cx + hw * asin(c·u) / c, u = (x − cx) / hw.
   * Identity at the centre of the body; art near the side seams curves away.
   * Outside the body span the mapping continues with a constant offset (no jump).
   */
  function warpRGBA(src, rows, c) {
    var out = new Uint8ClampedArray(src.length);
    var strength = c > 0 && c < 1 ? c : WRAP_C;
    var edgeFactor = Math.asin(strength) / strength - 1;
    var y;
    var x;
    for (y = 0; y < SIZE; y++) {
      var rowBase = y * SIZE * 4;
      var h = rows.hw[y];
      if (!rows.ok[y] || h < 4) {
        for (x = 0; x < SIZE * 4; x++) out[rowBase + x] = src[rowBase + x];
        continue;
      }
      var cx = rows.cx[y];
      var edgeOff = h * edgeFactor;
      for (x = 0; x < SIZE; x++) {
        var dx = x - cx;
        var u = dx / h;
        var sx;
        if (u >= -1 && u <= 1) {
          sx = cx + (h * Math.asin(strength * u)) / strength;
        } else {
          sx = x + (dx < 0 ? -edgeOff : edgeOff);
        }
        sx = clamp(sx, 0, SIZE - 1);
        var x0 = Math.floor(sx);
        var x1 = Math.min(SIZE - 1, x0 + 1);
        var f = sx - x0;
        var i0 = rowBase + x0 * 4;
        var i1 = rowBase + x1 * 4;
        var wa0 = (1 - f) * src[i0 + 3];
        var wa1 = f * src[i1 + 3];
        var a = wa0 + wa1;
        var j = rowBase + x * 4;
        if (a > 0) {
          out[j] = (src[i0] * wa0 + src[i1] * wa1) / a;
          out[j + 1] = (src[i0 + 1] * wa0 + src[i1 + 1] * wa1) / a;
          out[j + 2] = (src[i0 + 2] * wa0 + src[i1 + 2] * wa1) / a;
          out[j + 3] = a;
        }
      }
    }
    return out;
  }

  /** A point just outside the mask is "wrapped" if it is within the side wrap zone. */
  function inWrapZone(sil, x, y) {
    var r = sil.rows;
    var yi = Math.round(y);
    if (yi < r.first || yi > r.last || !r.ok[yi]) return false;
    return Math.abs(x - r.cx[yi]) <= r.hw[yi] * (1 + WRAP_OVERFLOW) + 0.5;
  }

  function isLarge(sil, box) {
    var r = sil.rows;
    var yc = clamp(Math.round(box.top + box.height / 2), r.first, r.last);
    var bodyWidth = 2 * r.hw[yc];
    return bodyWidth > 0 && box.width >= LARGE_RATIO * bodyWidth;
  }

  function bboxOfPoints(pts) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < pts.length; i++) {
      if (pts[i].x < minX) minX = pts[i].x;
      if (pts[i].x > maxX) maxX = pts[i].x;
      if (pts[i].y < minY) minY = pts[i].y;
      if (pts[i].y > maxY) maxY = pts[i].y;
    }
    return { left: minX, top: minY, width: maxX - minX, height: maxY - minY };
  }

  /**
   * @returns {{outside:number, viol:number, wrap:boolean}}
   *  outside = points off the garment, viol = points that break the rule
   *  (off the garment and not allowed to wrap).
   */
  function evaluatePoints(sil, pts, forceWrap) {
    var wrap = typeof forceWrap === "boolean" ? forceWrap : isLarge(sil, bboxOfPoints(pts));
    var outside = 0;
    var viol = 0;
    for (var i = 0; i < pts.length; i++) {
      if (maskAt(sil.mask, pts[i].x, pts[i].y)) continue;
      outside++;
      if (!(wrap && inWrapZone(sil, pts[i].x, pts[i].y))) viol++;
    }
    return { outside: outside, viol: viol, wrap: wrap };
  }

  /** Outline samples: each edge of the oriented box plus the centre. */
  function outlineFromCorners(corners) {
    var pts = [];
    var n = corners.length;
    for (var i = 0; i < n; i++) {
      var a = corners[i];
      var b = corners[(i + 1) % n];
      for (var s = 0; s < EDGE_SAMPLES; s++) {
        var t = s / EDGE_SAMPLES;
        pts.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    var cx = 0;
    var cy = 0;
    for (var k = 0; k < n; k++) {
      cx += corners[k].x;
      cy += corners[k].y;
    }
    pts.push({ x: cx / n, y: cy / n });
    return pts;
  }

  /* ======================================================================
   * Fabric helpers
   * ==================================================================== */

  function getFabric() {
    var C = global.BlytzCanvas;
    return C && typeof C.getFabricCanvas === "function" ? C.getFabricCanvas() : null;
  }

  function isLocked(obj) {
    var C = global.BlytzCanvas;
    try {
      return !!(C && typeof C.isObjectLocked === "function" && C.isObjectLocked(obj));
    } catch (err) {
      return false;
    }
  }

  function outlinePoints(obj) {
    var coords;
    try {
      coords = obj.getCoords();
    } catch (err) {
      return [];
    }
    if (!coords || coords.length < 4) return [];
    return outlineFromCorners(coords);
  }

  function evalObject(sil, obj, forceWrap) {
    var pts = outlinePoints(obj);
    if (!pts.length) return { outside: 0, viol: 0, wrap: false };
    return evaluatePoints(sil, pts, forceWrap);
  }

  function snapshot(obj) {
    var s = {};
    for (var i = 0; i < TRANSFORM_KEYS.length; i++) {
      s[TRANSFORM_KEYS[i]] = obj[TRANSFORM_KEYS[i]];
    }
    return s;
  }

  function restore(obj, state) {
    obj.set(state);
    obj.setCoords();
  }

  function remember(obj, sil) {
    if (!obj || !sil) return;
    records.set(obj, { state: snapshot(obj), v: evalObject(sil, obj).viol });
  }

  /**
   * Remember every object's current transform as its baseline (read-only).
   * Used so a manual drag knows where the object started. Never moves,
   * scales or restores anything.
   */
  function rememberAll() {
    var canvas = getFabric();
    var sil = current;
    if (!canvas || !sil) return;
    var objects = canvas.getObjects();
    for (var i = 0; i < objects.length; i++) {
      if (objects[i]) remember(objects[i], sil);
    }
  }

  /* ======================================================================
   * Live drag / scale / rotate: stop at the edge
   * ==================================================================== */

  function onTransforming(opt) {
    if (!ENFORCE_EDGE_STOP) return;
    var obj = opt && opt.target;
    var sil = current;
    if (!obj || !sil) return;
    var rec = records.get(obj);
    var ev = evalObject(sil, obj);
    if (!rec) {
      records.set(obj, { state: snapshot(obj), v: ev.viol });
      return;
    }
    if (ev.viol <= rec.v) {
      records.set(obj, { state: snapshot(obj), v: ev.viol });
      return;
    }

    var last = rec.state;
    var moving =
      last.scaleX === obj.scaleX &&
      last.scaleY === obj.scaleY &&
      last.angle === obj.angle;
    if (moving) {
      // Slide along the edge: try each axis on its own before giving up.
      var attempts = [
        { left: obj.left, top: last.top },
        { left: last.left, top: obj.top },
      ];
      for (var i = 0; i < attempts.length; i++) {
        obj.set(attempts[i]);
        obj.setCoords();
        var t = evalObject(sil, obj);
        if (t.viol <= rec.v) {
          records.set(obj, { state: snapshot(obj), v: t.viol });
          return;
        }
      }
    }
    restore(obj, last);
  }

  function onMouseDown(opt) {
    if (opt && opt.target && current) remember(opt.target, current);
  }

  var attachedCanvas = null;
  function attach(canvas) {
    if (!canvas || attachedCanvas === canvas) return;
    attachedCanvas = canvas;
    canvas.on("mouse:down", onMouseDown);
    canvas.on("object:moving", onTransforming);
    canvas.on("object:scaling", onTransforming);
    canvas.on("object:rotating", onTransforming);
    canvas.on("object:skewing", onTransforming);
  }

  /* ======================================================================
   * Silhouette loading (from the garment SVG clipPath)
   * ==================================================================== */

  function garmentFile(template, view) {
    var G = global.BlytzGarments;
    if (!G || typeof G.garmentById !== "function") return "";
    var g = G.garmentById(template);
    var v = g && g.views && g.views[view === "back" ? "back" : "front"];
    return v && v.svg ? v.svg : "";
  }

  function load(template, view) {
    var G = global.BlytzGarments;
    var file = garmentFile(template, view);
    if (!G || !file || typeof G.fetchSvgText !== "function") {
      return Promise.resolve(null);
    }
    if (loadPromises[file]) return loadPromises[file];
    loadPromises[file] = G.fetchSvgText(file)
      .then(function (text) {
        var doc = new DOMParser().parseFromString(text, "image/svg+xml");
        var clip = doc.querySelector("clipPath");
        if (!clip) return null;
        var ds = [];
        var paths = clip.querySelectorAll("path");
        for (var i = 0; i < paths.length; i++) {
          var d = paths[i].getAttribute("d");
          if (d) ds.push(d);
        }
        if (!ds.length) return null;
        var dAll = ds.join(" ");
        var path2d = new Path2D(dAll);
        var cv = document.createElement("canvas");
        cv.width = SIZE;
        cv.height = SIZE;
        var ctx = cv.getContext("2d", { willReadFrequently: true });
        if (!ctx) return null;
        ctx.fillStyle = "#000";
        ctx.fill(path2d);
        var data = ctx.getImageData(0, 0, SIZE, SIZE).data;
        var mask = new Uint8Array(SIZE * SIZE);
        for (var p = 0; p < mask.length; p++) mask[p] = data[p * 4 + 3] > 127 ? 1 : 0;
        var sil = buildSilhouette(mask);
        if (!sil) return null;
        sil.d = dAll;
        sil.path2d = path2d;
        sil.file = file;
        return sil;
      })
      .catch(function (err) {
        console.warn("BlytzSilhouette: could not read garment outline", file, err);
        delete loadPromises[file];
        return null;
      });
    return loadPromises[file];
  }

  /** CSS clip on the art canvas only (selection handles stay visible at the edge). */
  function applyEditorClip(sil) {
    var canvas = getFabric();
    if (!canvas || !canvas.lowerCanvasEl) return;
    var el = canvas.lowerCanvasEl;
    if (!sil) {
      el.style.clipPath = "";
      el.style.webkitClipPath = "";
      return;
    }
    var svg = document.getElementById(DEFS_ID);
    if (!svg) {
      svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("id", DEFS_ID);
      svg.setAttribute("width", "0");
      svg.setAttribute("height", "0");
      svg.setAttribute("aria-hidden", "true");
      svg.style.position = "absolute";
      svg.style.pointerEvents = "none";
      var defs = document.createElementNS(SVG_NS, "defs");
      var cp = document.createElementNS(SVG_NS, "clipPath");
      cp.setAttribute("id", CLIP_ID);
      cp.setAttribute("clipPathUnits", "objectBoundingBox");
      var path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("transform", "scale(" + 1 / SIZE + ")");
      cp.appendChild(path);
      defs.appendChild(cp);
      svg.appendChild(defs);
      document.body.appendChild(svg);
    }
    svg.querySelector("path").setAttribute("d", sil.d);
    el.style.clipPath = "url(#" + CLIP_ID + ")";
    el.style.webkitClipPath = "url(#" + CLIP_ID + ")";
  }

  /** Load the outline for the active garment + view, clip the canvas, and return it. */
  function sync() {
    var C = global.BlytzCanvas;
    if (!C || typeof C.getGarmentState !== "function") return Promise.resolve(null);
    var g = C.getGarmentState() || {};
    var view = typeof C.getActiveView === "function" ? C.getActiveView() : "front";
    var token = ++syncToken;
    return load(g.template || "tee", view).then(function (sil) {
      if (token !== syncToken) return sil;
      current = sil || null;
      applyEditorClip(current);
      return current;
    });
  }

  /**
   * Garment type or front/back changed: load the new outline and update the
   * visual clip. Objects are NOT touched: same size, same coordinates.
   */
  function refit() {
    return sync().then(function () {
      rememberAll();
    });
  }

  /* ======================================================================
   * Print-overflow warning (repurposed: "large design wraps around the sides")
   * ==================================================================== */

  function evaluateCanvas(canvas) {
    var sil = current;
    if (!sil || !canvas || typeof canvas.getObjects !== "function") return null;
    var wrapping = 0;
    var objs = canvas.getObjects();
    for (var i = 0; i < objs.length; i++) {
      var ev = evalObject(sil, objs[i]);
      if (ev.outside > 0) wrapping++;
    }
    return {
      overflow: wrapping > 0,
      defined: true,
      reason: wrapping > 0 ? "wrap" : "ok",
      count: wrapping,
    };
  }

  /* ======================================================================
   * Mock-up / preview: silhouette mask + wrap warp (flat design untouched)
   * ==================================================================== */

  /**
   * Draw the flat artwork image onto ctx, wrapped around the body and clipped
   * to the garment outline. Falls back to a plain draw if anything is missing.
   */
  function drawMockupArt(ctx, artImg, sil, size) {
    if (!sil || !sil.path2d) {
      ctx.drawImage(artImg, 0, 0, size, size);
      return;
    }
    var tmp = document.createElement("canvas");
    tmp.width = SIZE;
    tmp.height = SIZE;
    var tctx = tmp.getContext("2d", { willReadFrequently: true });
    if (!tctx) {
      ctx.drawImage(artImg, 0, 0, size, size);
      return;
    }
    tctx.drawImage(artImg, 0, 0, SIZE, SIZE);
    var img = tctx.getImageData(0, 0, SIZE, SIZE);
    var warped = warpRGBA(img.data, sil.rows, WRAP_C);
    tctx.putImageData(new ImageData(warped, SIZE, SIZE), 0, 0);
    ctx.save();
    ctx.clip(sil.path2d);
    ctx.drawImage(tmp, 0, 0, size, size);
    ctx.restore();
  }

  function boot() {
    var tries = 0;
    (function wait() {
      var C = global.BlytzCanvas;
      var canvas = C && typeof C.getFabricCanvas === "function" ? C.getFabricCanvas() : null;
      if (canvas && typeof C.getGarmentState === "function") {
        attach(canvas);
        sync();
        if (typeof C.onGarmentChange === "function") C.onGarmentChange(refit);
        if (typeof C.onViewChange === "function") C.onViewChange(refit);
        return;
      }
      if (++tries < 300) setTimeout(wait, 100);
    })();
  }

  global.BlytzSilhouette = {
    WRAP_C: WRAP_C,
    WRAP_OVERFLOW: WRAP_OVERFLOW,
    LARGE_RATIO: LARGE_RATIO,
    load: load,
    sync: sync,
    refit: refit,
    /** Kept for older call sites. Read-only now: never changes an object. */
    conformAll: function () {
      rememberAll();
      return 0;
    },
    /** Called by editor_canvas.js before every history snapshot. Read-only. */
    beforeCommit: function () {
      try {
        rememberAll();
      } catch (err) {
        console.error("BlytzSilhouette.beforeCommit", err);
      }
    },
    setEdgeStop: function (on) {
      ENFORCE_EDGE_STOP = !!on;
    },
    evaluateCanvas: evaluateCanvas,
    drawMockupArt: drawMockupArt,
    getCurrent: function () {
      return current;
    },
    /* exposed for tests */
    _test: {
      setCurrent: function (sil) {
        current = sil;
      },
      onTransforming: onTransforming,
      remember: remember,
      rememberAll: rememberAll,
    },
    _core: {
      SIZE: SIZE,
      buildSilhouette: buildSilhouette,
      warpRGBA: warpRGBA,
      evaluatePoints: evaluatePoints,
      outlineFromCorners: outlineFromCorners,
      maskAt: maskAt,
      isLarge: isLarge,
    },
  };

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", boot);
    } else {
      boot();
    }
  }
})(typeof window !== "undefined" ? window : globalThis);