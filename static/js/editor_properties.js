/**
 * Stage 3c — floating Properties panel (registry-driven controls).
 * Mutations go through BlytzCanvas.runSilent (live) and commitEdit (commit).
 */
(function (global) {
  "use strict";

  var wired = false;
  var collapsed = false;
  var forceClosed = false;
  var sheetOpen = false;
  var syncing = false;
  var rafId = 0;
  var keepProportions = true;
  var liveBaseline = null;
  var liveKey = null;
  /** Stage C: in-panel curve preview session (never committed until Apply). */
  var curveSession = null;
  /** Stage R.2: in-flight client-side background removal. */
  var bgRowBusy = false;

  /**
   * Property control registry: type → list of control ids.
   * Locking can later disable descriptors centrally.
   */
  var PROPERTY_REGISTRY = {
        rect: [
      "fill",
      "strokeStyle",
      "stroke",
      "cornerRadius",
      "opacity",
      "posX",
      "posY",
      "width",
      "height",
      "rotation",
      "keepProportions",
    ],
    ellipse: [
      "fill",
      "strokeStyle",
      "stroke",
      "opacity",
      "posX",
      "posY",
      "width",
      "height",
      "rotation",
      "keepProportions",
    ],
    polygon: [
      "fill",
      "strokeStyle",
      "stroke",
      "opacity",
      "posX",
      "posY",
      "width",
      "height",
      "rotation",
      "keepProportions",
    ],
    path: [
      "fill",
      "strokeStyle",
      "stroke",
      "opacity",
      "posX",
      "posY",
      "width",
      "height",
      "rotation",
      "keepProportions",
    ],
    line: ["strokeStyle", "stroke", "opacity", "posX", "posY", "width", "rotation"],
    itext: [
      "text",
      "fill",
      "fontFamily",
      "fontSize",
      "textStyle",
      "textAlign",
      "charSpacing",
      "lineHeight",
      "textCurve",
      "opacity",
      "posX",
      "posY",
      "rotation",
    ],
    text: [
      "text",
      "fill",
      "fontFamily",
      "fontSize",
      "textStyle",
      "textAlign",
      "charSpacing",
      "lineHeight",
      "textCurve",
      "opacity",
      "posX",
      "posY",
      "rotation",
    ],
    textbox: [
      "text",
      "fill",
      "fontFamily",
      "fontSize",
      "textStyle",
      "textAlign",
      "charSpacing",
      "lineHeight",
      "textCurve",
      "opacity",
      "posX",
      "posY",
      "rotation",
    ],
    image: [
      "opacity",
      "posX",
      "posY",
      "width",
      "height",
      "keepProportions",
      "rotation",
      "imagePlacement",
    ],
  };

  function api() {
    return global.BlytzCanvas;
  }

  function canvas() {
    return api() && api().getFabricCanvas();
  }

  function limits() {
    return (api() && api().PROP_LIMITS) || {};
  }

  function presets() {
    return (api() && api().COLOR_PRESETS) || [];
  }

  function fonts() {
    return (api() && api().ALLOWED_FONTS) || ["Arial"];
  }

  function isNarrowProps() {
    // Use min-width:1280 inversion so subpixel widths in (1279, 1280) stay exclusive.
    return (
      window.matchMedia && !window.matchMedia("(min-width: 1280px)").matches
    );
  }

  function isMobileToolbar() {
    return window.matchMedia && window.matchMedia("(max-width: 1023px)").matches;
  }

  function panelEl() {
    return document.getElementById("editor-properties-panel");
  }

  function pillEl() {
    return document.getElementById("editor-props-pill");
  }

  function bodyEl() {
    return document.querySelector("[data-props-body]");
  }

  function typeKey(obj) {
    if (!obj) return "";
    var a = api();
    if (a && typeof a.typeKey === "function") return a.typeKey(obj);
    return String(obj.type || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  }

  function isToolPanelOpen() {
    return !!(
      global.BlytzEditorTools &&
      typeof global.BlytzEditorTools.getOpenPanelId === "function" &&
      global.BlytzEditorTools.getOpenPanelId()
    );
  }

  function clamp(n, lo, hi) {
    if (typeof n !== "number" || isNaN(n)) return null;
    return Math.min(hi, Math.max(lo, n));
  }

  function normAngle(a) {
    var L = limits();
    var n = ((a % 360) + 360) % 360;
    if (n > L.rotationMax) n = L.rotationMax;
    return n;
  }

  function colorToHex(c) {
    if (!c || typeof c !== "string") return "#000000";
    if (c.charAt(0) === "#" && (c.length === 7 || c.length === 4)) {
      if (c.length === 4) {
        return (
          "#" +
          c.charAt(1) +
          c.charAt(1) +
          c.charAt(2) +
          c.charAt(2) +
          c.charAt(3) +
          c.charAt(3)
        );
      }
      return c.toLowerCase();
    }
    var m = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (m) {
      return (
        "#" +
        [m[1], m[2], m[3]]
          .map(function (x) {
            var h = Number(x).toString(16);
            return h.length === 1 ? "0" + h : h;
          })
          .join("")
      );
    }
    return "#000000";
  }

  function isTextType(obj) {
    var k = typeKey(obj);
    return k === "itext" || k === "text" || k === "textbox";
  }

  function isBoldWeight(weight) {
    if (weight === true) return true;
    if (typeof weight === "number") return weight >= 600;
    var s = String(weight || "normal").toLowerCase();
    return s === "bold" || s === "700" || s === "800" || s === "900";
  }

  function isItalicStyle(style) {
    if (style === true) return true;
    var s = String(style || "normal").toLowerCase();
    return s === "italic" || s === "oblique";
  }

  function isUnderlined(value) {
    return value === true || value === 1 || value === "true" || value === "1";
  }

  function normalizeTextAlign(value) {
    var allowed =
      (api() && api().TEXT_ALIGN_VALUES) || ["left", "center", "right"];
    var v = String(value || "left").toLowerCase();
    return allowed.indexOf(v) >= 0 ? v : "left";
  }

  function readSnapshot(obj) {
    if (!obj) return null;
    var c = obj.getCenterPoint();
    var w = obj.getScaledWidth();
    var h = obj.getScaledHeight();
    return {
      fill: obj.fill,
      stroke: obj.stroke,
      strokeWidth: obj.strokeWidth,
      dash: obj.strokeDashArray ? obj.strokeDashArray.join(",") : "",
      cap: obj.strokeLineCap,
      rx: obj.rx,
      ry: obj.ry,
      opacity: obj.opacity,
      angle: obj.angle,
      left: obj.left,
      top: obj.top,
      scaleX: obj.scaleX,
      scaleY: obj.scaleY,
      width: obj.width,
      height: obj.height,
      fontSize: obj.fontSize,
      fontFamily: obj.fontFamily,
      fontWeight: obj.fontWeight,
      fontStyle: obj.fontStyle,
      underline: obj.underline,
      textAlign: obj.textAlign,
      charSpacing: obj.charSpacing,
      lineHeight: obj.lineHeight,
      text: obj.text,
      cx: c.x,
      cy: c.y,
      sw: w,
      sh: h,
    };
  }

  function snapshotsEqual(a, b) {
    if (!a || !b) return false;
    var keys = Object.keys(a);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (a[k] !== b[k]) return false;
    }
    return true;
  }

  function getJSON() {
    return global.BlytzEditor && global.BlytzEditor.getCanvasJSON();
  }

    /* ================= Border style + corner rounding ================= */
  var STROKE_DEFAULT_WIDTH = 4;
  var lastStrokeColor = "#000000";
  var STROKE_IDS = ["none", "solid", "dashed", "long", "dotted"];

  function strokeSvg(dash, cap) {
    return (
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" ' +
      'stroke-linecap="' + (cap || "butt") + '" aria-hidden="true" focusable="false">' +
      '<path d="M2 12h20"' + (dash ? ' stroke-dasharray="' + dash + '"' : "") + "/></svg>"
    );
  }

  var STROKE_STYLES = [
    {
      id: "none",
      title: "No border",
      svg:
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
        'stroke-linecap="round" aria-hidden="true" focusable="false">' +
        '<circle cx="12" cy="12" r="8"/><path d="M6.3 17.7L17.7 6.3"/></svg>',
    },
    { id: "solid", title: "Solid line", svg: strokeSvg("", "butt") },
    { id: "dashed", title: "Dashed line", svg: strokeSvg("4 3", "butt") },
    { id: "long", title: "Long dashed line", svg: strokeSvg("9 4", "butt") },
    { id: "dotted", title: "Dotted line", svg: strokeSvg("0.1 4.5", "round") },
  ];

  function supportsBorder(obj) {
    var k = typeKey(obj);
    return (
      k === "rect" || k === "ellipse" || k === "polygon" || k === "path" || k === "line"
    );
  }

  function strokeBounds(obj) {
    var L = limits();
    return {
      min: typeKey(obj) === "line" ? 1 : 0,
      max: L.strokeWidthMax != null ? L.strokeWidthMax : 40,
    };
  }

  /** Read the current border style back from the object. */
  function strokeStyleOf(obj) {
    var w = Number(obj && obj.strokeWidth) || 0;
    if (!obj || !obj.stroke || w <= 0) return "none";
    var d = obj.strokeDashArray;
    if (!d || !d.length) return "solid";
    var ratio = d[0] / w;
    if (obj.strokeLineCap === "round" && ratio < 0.5) return "dotted";
    return ratio >= 4.5 ? "long" : "dashed";
  }

  /** Dash pattern scales with the weight so the look stays the same at any width. */
  function dashFor(style, w) {
    if (style === "dashed") return { dash: [w * 3, w * 2], cap: "butt" };
    if (style === "long") return { dash: [w * 6, w * 3], cap: "butt" };
    if (style === "dotted") return { dash: [0.01, w * 2], cap: "round" };
    return { dash: null, cap: "butt" };
  }

  function applyStrokeStyle(obj, style) {
    if (STROKE_IDS.indexOf(style) < 0 || !supportsBorder(obj)) return false;
    if (style === "none") {
      if (typeKey(obj) === "line") return false; // a line IS its stroke
      if (obj.stroke) lastStrokeColor = obj.stroke;
      obj.set({
        stroke: null,
        strokeWidth: 0,
        strokeDashArray: null,
        strokeLineCap: "butt",
      });
      return true;
    }
    var w = Number(obj.strokeWidth) || 0;
    if (w <= 0) w = STROKE_DEFAULT_WIDTH; // default weight = 4
    if (!obj.stroke) obj.set("stroke", lastStrokeColor || "#000000");
    var d = dashFor(style, w);
    obj.set({ strokeWidth: w, strokeDashArray: d.dash, strokeLineCap: d.cap });
    return true;
  }

  function applyStrokeWidth(obj, value) {
    if (!supportsBorder(obj)) return false;
    var b = strokeBounds(obj);
    var sw = clamp(value, b.min, b.max);
    if (sw === null) return false;
    if (sw <= 0) return applyStrokeStyle(obj, "none"); // weight 0 = remove border
    var style = strokeStyleOf(obj);
    if (style === "none") style = "solid";
    if (!obj.stroke) obj.set("stroke", lastStrokeColor || "#000000");
    var d = dashFor(style, sw);
    obj.set({ strokeWidth: sw, strokeDashArray: d.dash, strokeLineCap: d.cap });
    return true;
  }

  /* Corner radius is shown in canvas pixels; rx/ry are divided by the scale so
     corners stay round even when the rectangle is stretched. */
  function cornerRadiusOf(obj) {
    if (!obj || typeKey(obj) !== "rect") return 0;
    return Math.round((obj.rx || 0) * Math.abs(obj.scaleX || 1) * 100) / 100;
  }

  function maxCornerRadius(obj) {
    return Math.max(0, Math.floor(Math.min(obj.getScaledWidth(), obj.getScaledHeight()) / 2));
  }

  function setCornerRadius(obj, r) {
    var rr = Math.max(0, Math.min(r, maxCornerRadius(obj)));
    var sx = Math.abs(obj.scaleX) || 1;
    var sy = Math.abs(obj.scaleY) || 1;
    obj.set({ rx: rr / sx, ry: rr / sy });
  }

  /** Gold "filled" part of the slider track (see CSS). */
  function setRangeFill(input) {
    if (!input || input.type !== "range") return;
    var min = Number(input.min) || 0;
    var max = Number(input.max);
    if (isNaN(max) || max <= min) max = min + 1;
    var pct = ((Number(input.value) - min) / (max - min)) * 100;
    input.style.setProperty("--fill", Math.max(0, Math.min(100, pct)) + "%");
  }

  /** Keep buttons / colour row / numbers in sync with the object. */
  function patchBorderControls(body, obj) {
    if (!body || !obj) return;
    var style = strokeStyleOf(obj);
    body.querySelectorAll("[data-stroke-style]").forEach(function (btn) {
      var on = btn.getAttribute("data-stroke-style") === style;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("is-active", on);
    });
    var colorRow = body.querySelector("[data-stroke-color-row]");
    if (colorRow) colorRow.hidden = style === "none";
    var sw = style === "none" ? 0 : Number(obj.strokeWidth) || 0;
    body.querySelectorAll('[data-prop="strokeWidth"]').forEach(function (inp) {
      if (document.activeElement !== inp) inp.value = String(Math.round(sw * 100) / 100);
    });
    if (typeKey(obj) === "rect") {
      var cr = cornerRadiusOf(obj);
      var maxR = maxCornerRadius(obj);
      body.querySelectorAll('[data-prop="cornerRadius"]').forEach(function (inp) {
        inp.setAttribute("max", String(maxR));
        if (document.activeElement !== inp) inp.value = String(cr);
      });
    }
    body.querySelectorAll(".editor-props-range--filled").forEach(setRangeFill);
  }

  function buildBorderStyleControl(obj) {
    var isLine = typeKey(obj) === "line";
    var wrap = el("div", { className: "editor-props-border" });
    var group = el("div", {
      className: "editor-props-strokestyle",
      role: "group",
      "aria-label": "Border style",
    });
    STROKE_STYLES.forEach(function (spec) {
      if (spec.id === "none" && isLine) return;
      var btn = el("button", {
        type: "button",
        className: "editor-props-strokestyle-btn",
        "data-stroke-style": spec.id,
        title: spec.title,
        "aria-label": spec.title,
        "aria-pressed": "false",
      });
      btn.innerHTML = spec.svg;
      group.appendChild(btn);
    });
    wrap.appendChild(group);

    var b = strokeBounds(obj);
    var sw = strokeStyleOf(obj) === "none" ? 0 : Number(obj.strokeWidth) || 0;
    var range = el("input", {
      type: "range",
      className: "editor-props-range editor-props-range--filled",
      "data-prop": "strokeWidth",
      min: String(b.min),
      max: String(b.max),
      step: "1",
      value: String(sw),
      "aria-label": "Border weight",
    });
    var num = el("input", {
      type: "number",
      className: "editor-props-input editor-props-weight-num",
      "data-prop": "strokeWidth",
      min: String(b.min),
      max: String(b.max),
      step: "1",
      value: String(sw),
      "aria-label": "Border weight in pixels",
    });
    wrap.appendChild(
      labeledRow(
        "Border weight",
        el("div", { className: "editor-props-range-wrap" }, [range, num])
      )
    );
    patchBorderControls(wrap, obj);
    return wrap;
  }

  function buildCornerControl(obj) {
    var maxR = maxCornerRadius(obj);
    var cr = cornerRadiusOf(obj);
    var range = el("input", {
      type: "range",
      className: "editor-props-range editor-props-range--filled",
      "data-prop": "cornerRadius",
      min: "0",
      max: String(maxR),
      step: "1",
      value: String(cr),
      "aria-label": "Corner rounding",
    });
    var num = el("input", {
      type: "number",
      className: "editor-props-input editor-props-weight-num",
      "data-prop": "cornerRadius",
      min: "0",
      max: String(maxR),
      step: "1",
      value: String(cr),
      "aria-label": "Corner rounding in pixels",
    });
    setRangeFill(range);
    return labeledRow(
      "Corner rounding",
      el("div", { className: "editor-props-range-wrap" }, [range, num])
    );
  }

  function applyField(obj, key, value, opts) {
    opts = opts || {};
    var L = limits();
    var cnv = canvas();
    if (!obj || !cnv) return false;

    if (key === "fill") {
      obj.set("fill", value);
    } else if (key === "stroke") {
      if (value) lastStrokeColor = value;
      obj.set("stroke", value || null);
    } else if (key === "strokeWidth") {
      if (!applyStrokeWidth(obj, value)) return false;
    } else if (key === "strokeStyle") {
      if (!applyStrokeStyle(obj, value)) return false;
    } else if (key === "cornerRadius") {
      if (typeKey(obj) !== "rect") return false;
      if (typeof value !== "number" || isNaN(value) || !isFinite(value)) return false;
      setCornerRadius(obj, value);
    } else if (key === "opacity") {
      var op = clamp(value, L.opacityMin, L.opacityMax);
      if (op === null) return false;
      obj.set("opacity", op);
    } else if (key === "rotation") {
      if (typeof value !== "number" || isNaN(value) || !isFinite(value)) return false;
      // Preserve center so angle edits do not jump when origin is left/top.
      var rotCenter =
        typeof obj.getCenterPoint === "function"
          ? obj.getCenterPoint()
          : { x: obj.left || 0, y: obj.top || 0 };
      obj.set("angle", normAngle(value));
      var rotPoint = global.fabric && (global.fabric.Point || global.fabric.point);
      var rotPt = rotPoint
        ? new rotPoint(rotCenter.x, rotCenter.y)
        : { x: rotCenter.x, y: rotCenter.y };
      if (typeof obj.setPositionByOrigin === "function") {
        obj.setPositionByOrigin(rotPt, "center", "center");
      }
    } else if (key === "posX" || key === "posY") {
      var center = obj.getCenterPoint();
      var nx = key === "posX" ? clamp(value, L.posMin, L.posMax) : center.x;
      var ny = key === "posY" ? clamp(value, L.posMin, L.posMax) : center.y;
      if (nx === null || ny === null) return false;
      var Point = global.fabric.Point || global.fabric.point;
      var pt = Point ? new Point(nx, ny) : { x: nx, y: ny };
      if (typeof obj.setPositionByOrigin === "function") {
        obj.setPositionByOrigin(pt, "center", "center");
      } else {
        obj.set({ left: nx, top: ny, originX: "center", originY: "center" });
      }
    } else if (key === "width" || key === "height") {
      // Reject blank / non-finite / zero / negative (do not coerce into sizeMin).
      if (typeof value !== "number" || isNaN(value) || !isFinite(value) || value <= 0) {
        return false;
      }
      var size = clamp(value, L.sizeMin, L.sizeMax);
      if (size === null) return false;
      var baseW = obj.width || 1;
      var baseH = obj.height || 1;
      var keepCorner = cornerRadiusOf(obj);
      if (typeKey(obj) === "line" && key === "width") {
        // Line length via scaleX relative to native width.
        obj.set("scaleX", size / Math.max(baseW, 0.0001));
      } else if (key === "width") {
        var sx = size / Math.max(baseW, 0.0001);
        obj.set("scaleX", sx);
        if (keepProportions && !opts.skipKeep) {
          obj.set("scaleY", sx);
        }
      } else {
        var sy = size / Math.max(baseH, 0.0001);
        obj.set("scaleY", sy);
        if (keepProportions && !opts.skipKeep) {
          obj.set("scaleX", sy);
        }
      }
      if (keepCorner > 0) setCornerRadius(obj, keepCorner);
    } else if (key === "fontSize") {
      var fs = clamp(value, L.fontSizeMin, L.fontSizeMax);
      if (fs === null) return false;
      obj.set("fontSize", fs);
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else if (key === "fontFamily") {
      if (fonts().indexOf(value) === -1) return false;
      obj.set("fontFamily", value);
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else if (key === "text") {
      var t = String(value == null ? "" : value);
      if (t.length < L.textMin || t.length > L.textMax) return false;
      obj.set("text", t);
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else if (key === "fontWeight") {
      if (!isTextType(obj)) return false;
      var bold = value === true || value === "bold" || value === 700 || value === "700";
      obj.set("fontWeight", bold ? "bold" : "normal");
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else if (key === "fontStyle") {
      if (!isTextType(obj)) return false;
      obj.set("fontStyle", isItalicStyle(value) ? "italic" : "normal");
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else if (key === "underline") {
      if (!isTextType(obj)) return false;
      obj.set("underline", isUnderlined(value));
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else if (key === "textAlign") {
      if (!isTextType(obj)) return false;
      obj.set("textAlign", normalizeTextAlign(value));
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else if (key === "charSpacing") {
      if (!isTextType(obj)) return false;
      var cs = clamp(
        value,
        L.charSpacingMin != null ? L.charSpacingMin : -200,
        L.charSpacingMax != null ? L.charSpacingMax : 800
      );
      if (cs === null) return false;
      obj.set("charSpacing", cs);
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else if (key === "lineHeight") {
      if (!isTextType(obj)) return false;
      var lh = clamp(
        value,
        L.lineHeightMin != null ? L.lineHeightMin : 0.8,
        L.lineHeightMax != null ? L.lineHeightMax : 2.5
      );
      if (lh === null) return false;
      obj.set("lineHeight", lh);
      if (typeof obj.initDimensions === "function") obj.initDimensions();
    } else {
      return false;
    }
    obj.setCoords();
    cnv.requestRenderAll();
    return true;
  }

  function nearlyEqual(a, b) {
    if (a === b) return true;
    if (typeof a !== "number" || typeof b !== "number") return false;
    if (isNaN(a) || isNaN(b)) return false;
    return Math.abs(a - b) < 0.001;
  }

  /** True if applying clamped value would change the object. */
  function fieldWouldChange(obj, key, value) {
    var L = limits();
    if (!obj) return false;
    if (key === "fill") {
      return colorToHex(obj.fill) !== colorToHex(value);
    }
    if (key === "stroke") {
      var nextStroke = value || null;
      var curStroke = obj.stroke || null;
      if (!nextStroke && !curStroke) return false;
      if (!nextStroke || !curStroke) return true;
      return colorToHex(curStroke) !== colorToHex(nextStroke);
    }
    if (key === "strokeWidth") {
      var bnd = strokeBounds(obj);
      var swv = clamp(value, bnd.min, bnd.max);
      if (swv === null) return false;
      if (swv <= 0) return strokeStyleOf(obj) !== "none";
      return (
        strokeStyleOf(obj) === "none" ||
        !nearlyEqual(obj.strokeWidth == null ? 0 : obj.strokeWidth, swv)
      );
    }
    if (key === "strokeStyle") {
      if (STROKE_IDS.indexOf(value) < 0 || !supportsBorder(obj)) return false;
      if (value === "none" && typeKey(obj) === "line") return false;
      return strokeStyleOf(obj) !== value;
    }
    if (key === "cornerRadius") {
      if (typeKey(obj) !== "rect") return false;
      if (typeof value !== "number" || isNaN(value)) return false;
      var crv = Math.max(0, Math.min(value, maxCornerRadius(obj)));
      return !nearlyEqual(cornerRadiusOf(obj), crv);
    }
    if (key === "opacity") {
      var op = clamp(value, L.opacityMin, L.opacityMax);
      if (op === null) return false;
      return !nearlyEqual(obj.opacity == null ? 1 : obj.opacity, op);
    }
    if (key === "rotation") {
      if (typeof value !== "number" || isNaN(value)) return false;
      return !nearlyEqual(normAngle(obj.angle || 0), normAngle(value));
    }
    if (key === "posX" || key === "posY") {
      var center = obj.getCenterPoint();
      var nx = key === "posX" ? clamp(value, L.posMin, L.posMax) : center.x;
      var ny = key === "posY" ? clamp(value, L.posMin, L.posMax) : center.y;
      if (nx === null || ny === null) return false;
      return !(nearlyEqual(center.x, nx) && nearlyEqual(center.y, ny));
    }
    if (key === "width") {
      if (typeof value !== "number" || isNaN(value) || !isFinite(value) || value <= 0) {
        return false;
      }
      var sizeW = clamp(value, L.sizeMin, L.sizeMax);
      if (sizeW === null) return false;
      return !nearlyEqual(obj.getScaledWidth(), sizeW);
    }
    if (key === "height") {
      if (typeof value !== "number" || isNaN(value) || !isFinite(value) || value <= 0) {
        return false;
      }
      var sizeH = clamp(value, L.sizeMin, L.sizeMax);
      if (sizeH === null) return false;
      return !nearlyEqual(obj.getScaledHeight(), sizeH);
    }
    if (key === "fontSize") {
      var fs = clamp(value, L.fontSizeMin, L.fontSizeMax);
      if (fs === null) return false;
      return !nearlyEqual(obj.fontSize, fs);
    }
    if (key === "fontFamily") {
      if (fonts().indexOf(value) === -1) return false;
      return String(obj.fontFamily || "") !== String(value || "");
    }
    if (key === "text") {
      var t = String(value == null ? "" : value);
      if (t.length < L.textMin || t.length > L.textMax) return false;
      return String(obj.text || "") !== t;
    }
    if (key === "fontWeight") {
      if (!isTextType(obj)) return false;
      var wantBold =
        value === true || value === "bold" || value === 700 || value === "700";
      return isBoldWeight(obj.fontWeight) !== wantBold;
    }
    if (key === "fontStyle") {
      if (!isTextType(obj)) return false;
      return isItalicStyle(obj.fontStyle) !== isItalicStyle(value);
    }
    if (key === "underline") {
      if (!isTextType(obj)) return false;
      return isUnderlined(obj.underline) !== isUnderlined(value);
    }
    if (key === "textAlign") {
      if (!isTextType(obj)) return false;
      return normalizeTextAlign(obj.textAlign) !== normalizeTextAlign(value);
    }
    if (key === "charSpacing") {
      if (!isTextType(obj)) return false;
      var cs = clamp(
        value,
        L.charSpacingMin != null ? L.charSpacingMin : -200,
        L.charSpacingMax != null ? L.charSpacingMax : 800
      );
      if (cs === null) return false;
      return !nearlyEqual(obj.charSpacing == null ? 0 : obj.charSpacing, cs);
    }
    if (key === "lineHeight") {
      if (!isTextType(obj)) return false;
      var lh = clamp(
        value,
        L.lineHeightMin != null ? L.lineHeightMin : 0.8,
        L.lineHeightMax != null ? L.lineHeightMax : 2.5
      );
      if (lh === null) return false;
      return !nearlyEqual(obj.lineHeight == null ? 1.16 : obj.lineHeight, lh);
    }
    return false;
  }

  function commitField(obj, key, value, opts) {
    var a = api();
    if (!a || !obj) return false;
    if (a.isActiveSelection(obj)) return false;
    if (a.isObjectLocked && a.isObjectLocked(obj)) return false;
    if (!isTextType(obj) &&
        (key === "fontWeight" ||
          key === "fontStyle" ||
          key === "underline" ||
          key === "textAlign" ||
          key === "charSpacing" ||
          key === "lineHeight" ||
          key === "text" ||
          key === "fontSize" ||
          key === "fontFamily")) {
      return false;
    }
    if ((key === "strokeStyle" || key === "cornerRadius") && !supportsBorder(obj)) {
      return false;
    }
    if (!fieldWouldChange(obj, key, value)) {
      scheduleSync();
      return false;
    }
    var before = readSnapshot(obj);
    var ok = a.commitEdit(
      "prop-" + key,
      function () {
        return applyField(obj, key, value, opts) !== false;
      },
      getJSON
    );
    if (ok) scheduleSync();
    else if (before) {
      // Revert UI if commit skipped (e.g. apply failed).
      scheduleSync();
    }
    return ok;
  }

  function beginLive(obj, key) {
    if (api() && api().isObjectLocked && api().isObjectLocked(obj)) return;
    liveBaseline = readSnapshot(obj);
    liveKey = key;
  }

  function liveUpdate(obj, key, value, opts) {
    var a = api();
    if (!a || !obj) return;
    if (a.isObjectLocked && a.isObjectLocked(obj)) return;
    a.runSilent(function () {
      applyField(obj, key, value, opts);
    });
  }

  function endLive(obj, key) {
    var a = api();
    if (!a || !obj || !liveBaseline) {
      liveBaseline = null;
      liveKey = null;
      return;
    }
    var after = readSnapshot(obj);
    var changed = !snapshotsEqual(liveBaseline, after);
    liveBaseline = null;
    liveKey = null;
    if (!changed) {
      scheduleSync();
      return;
    }
    // One commit for the whole drag/interaction.
    a.commitEdit(
      "prop-" + (key || "live"),
      function () {
        return true;
      },
      getJSON
    );
    scheduleSync();
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "className") node.className = attrs[k];
        else if (k === "text") node.textContent = attrs[k];
        else if (k === "value") node.value = attrs[k];
        else node.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

  function labeledRow(labelText, control, hint) {
    var lab = el("label", { className: "editor-props-label" });
    lab.appendChild(document.createTextNode(labelText));
    var row = el("div", { className: "editor-props-row" }, [lab, control]);
    if (hint) {
      row.appendChild(el("span", { className: "editor-props-hint", text: hint }));
    }
    return row;
  }

  function numberInput(key, value, step) {
    var input = el("input", {
      type: "number",
      className: "editor-props-input",
      "data-prop": key,
      step: String(step == null ? 1 : step),
      value: value == null || isNaN(value) ? "" : String(Math.round(value * 1000) / 1000),
    });
    return input;
  }

  function buildColorControl(key, value) {
    var wrap = el("div", { className: "editor-props-color" });
    var picker = el("input", {
      type: "color",
      className: "editor-props-color-input",
      "data-prop": key,
      value: colorToHex(value),
    });
    wrap.appendChild(picker);
    var swatches = el("div", { className: "editor-props-swatches", role: "list" });
    presets().forEach(function (hex) {
      var btn = el("button", {
        type: "button",
        className: "editor-props-swatch",
        "data-prop-swatch": key,
        "data-color": hex,
        "aria-label": "Set " + key + " to " + hex,
        title: hex,
      });
      btn.style.background = hex;
      swatches.appendChild(btn);
    });
    wrap.appendChild(swatches);
    return wrap;
  }

  function alignBtn(action, label, title, disabled) {
    var btn = el("button", {
      type: "button",
      className: "editor-props-align-btn",
      "data-align-action": action,
      text: label,
      title: title || label,
      "aria-label": title || label,
    });
    if (disabled) btn.disabled = true;
    return btn;
  }

  function centerBtn(axis, label, title, disabled) {
    var btn = el("button", {
      type: "button",
      className: "editor-props-align-btn",
      "data-center-action": axis,
      text: label,
      title: title || label,
      "aria-label": title || label,
    });
    if (disabled) btn.disabled = true;
    return btn;
  }

  function flipBtn(axis, label, title, disabled) {
    var btn = el("button", {
      type: "button",
      className: "editor-props-align-btn",
      "data-flip-action": axis,
      text: label,
      title: title || label,
      "aria-label": title || label,
    });
    if (disabled) btn.disabled = true;
    return btn;
  }

  function distributeBtn(axis, label, title, disabled) {
    var btn = el("button", {
      type: "button",
      className: "editor-props-align-btn",
      "data-distribute-action": axis,
      text: label,
      title: title || label,
      "aria-label": title || label,
    });
    if (disabled) btn.disabled = true;
    return btn;
  }

  function removeBgClientReady() {
    var api = global.BlytzRemoveBg;
    return !!(api && typeof api.removeToDataUrl === "function" && api.supported());
  }

  function buildImagePlacementControls(locked) {
    var section = el("div", { className: "editor-props-align editor-props-image-place" });
    section.appendChild(
      el("p", {
        className: "editor-props-align-heading",
        text: "Image placement",
      })
    );
    var row = el("div", { className: "editor-props-align-row" });
    var actions = [
      {
        attr: "data-image-place",
        value: "center",
        label: "Center",
        title: "Center image on the logical canvas",
      },
      {
        attr: "data-image-place",
        value: "fit",
        label: "Fit",
        title: "Fit image within the canvas (preserve aspect, not stretch)",
      },
      {
        attr: "data-image-place",
        value: "reset-rotation",
        label: "Reset °",
        title: "Reset rotation to 0° (keeps size, opacity, and position center)",
      },
    ];
    actions.forEach(function (spec) {
      var btn = el("button", {
        type: "button",
        className: "editor-props-align-btn",
        text: spec.label,
        title: spec.title,
        "aria-label": spec.title,
      });
      btn.setAttribute(spec.attr, spec.value);
      if (locked) btn.disabled = true;
      row.appendChild(btn);
    });
    section.appendChild(row);

    // Stage R.2 — client-side @imgly/background-removal (no server / API key).
    var bgReady = removeBgClientReady();
    var bgRow = el("div", { className: "editor-props-align-row" });
    var bgBtn = el("button", {
      type: "button",
      className: "editor-props-align-btn",
      text: "Remove BG",
      title: bgReady
        ? "Remove background in the browser (first run may download a model)"
        : "Background removal is unavailable in this browser",
      "aria-label": "Remove image background",
    });
    bgBtn.setAttribute("data-image-place", "remove-bg");
    if (locked || !bgReady) bgBtn.disabled = true;
    bgRow.appendChild(bgBtn);
    section.appendChild(bgRow);
    return section;
  }

  function runRemoveBackground(getJSON) {
    var a = api();
    if (!a || !a.replaceActiveImageSrc) return;
    if (!removeBgClientReady()) {
      if (a.setToolFeedback) {
        a.setToolFeedback("Background removal is unavailable in this browser.");
      }
      return;
    }
    var canvas = a.getFabricCanvas && a.getFabricCanvas();
    var obj = canvas && canvas.getActiveObject && canvas.getActiveObject();
    if (!obj || typeKey(obj) !== "image") {
      if (a.setToolFeedback) {
        a.setToolFeedback("Select a single image to remove its background.");
      }
      return;
    }
    if (a.isObjectLocked && a.isObjectLocked(obj)) {
      if (a.setToolFeedback) {
        a.setToolFeedback("Unlock the image in Layers to edit it.");
      }
      return;
    }
    var src =
      obj.getSrc && typeof obj.getSrc === "function"
        ? obj.getSrc()
        : obj.get && obj.get("src") != null
          ? obj.get("src")
          : obj.src;
    if (typeof src !== "string" || src.indexOf("data:image/") !== 0) {
      if (a.setToolFeedback) {
        a.setToolFeedback(
          "Only uploaded images (data URLs) can use background removal."
        );
      }
      return;
    }
    if (bgRowBusy) return;
    bgRowBusy = true;
    if (a.setToolFeedback) a.setToolFeedback("Loading model…");
    global.BlytzRemoveBg.removeToDataUrl(src, {
      onLoadStart: function () {
        if (a.setToolFeedback) a.setToolFeedback("Loading model…");
      },
      progress: function (key, current, total) {
        if (!a.setToolFeedback) return;
        if (key === "compute:inference") {
          a.setToolFeedback("Removing background…");
          return;
        }
        if (typeof current === "number" && typeof total === "number" && total > 0) {
          var pct = Math.min(100, Math.round((current / total) * 100));
          a.setToolFeedback("Loading model… " + pct + "%");
        } else {
          a.setToolFeedback("Removing background…");
        }
      },
    })
      .then(function (dataUrl) {
        if (typeof dataUrl !== "string" || dataUrl.indexOf("data:image/") !== 0) {
          if (a.setToolFeedback) {
            a.setToolFeedback("Background removal returned an invalid image.");
          }
          return;
        }
        if (a.setToolFeedback) a.setToolFeedback("Applying…");
        return a.replaceActiveImageSrc(dataUrl, getJSON);
      })
      .catch(function () {
        if (a.setToolFeedback) {
          a.setToolFeedback(
            "Background removal failed. Check your network and try again."
          );
        }
      })
      .then(function () {
        bgRowBusy = false;
      });
  }

  /**
   * Composition controls (Stage 2 / F). opts:
   *   isMulti, count, locked — selection-dependent enable/disable (no fake-enabled).
   */
  function buildAlignFlipControls(opts) {
    var isMulti = !!(opts && opts.isMulti);
    var count = (opts && opts.count) || (isMulti ? 2 : 1);
    var locked = !!(opts && opts.locked);
    var canCompose = !locked;
    var canDistribute = canCompose && isMulti && count >= 3;
    var a = api();
    var canLayout = !!(
      a &&
      a.canAutoLayoutSelected &&
      a.canAutoLayoutSelected()
    );
    var section = el("div", { className: "editor-props-align" });
    section.appendChild(
      el("p", {
        className: "editor-props-align-heading",
        text: "Auto layout",
      })
    );
    section.appendChild(
      el("div", { className: "editor-props-align-row" }, [
        (function () {
        var btn = el("button", {
          type: "button",
          className: "editor-props-align-btn",
          "data-auto-layout-selected": "1",
          text: "Auto Layout Selected",
          title: canLayout
            ? "Arrange only the selected object on the garment"
            : "Select one unlocked text, image, or element to use auto layout",
          "aria-label": "Auto Layout Selected",
        });
          if (!canLayout) btn.disabled = true;
          return btn;
        })(),
      ])
    );
    if (locked) {
      section.appendChild(
        el("p", {
          className: "editor-props-readonly",
          text: "Locked layers in selection — unlock to align or distribute",
        })
      );
    }
    if (isMulti) {
      section.appendChild(
        el("p", {
          className: "editor-props-align-heading",
          text: "Align selected objects",
        })
      );
      section.appendChild(
        el("div", { className: "editor-props-align-row" }, [
          alignBtn(
            "selection:left",
            "Left",
            "Align left edges of selection",
            !canCompose
          ),
          alignBtn(
            "selection:hcenter",
            "Center",
            "Align horizontal centers of selection",
            !canCompose
          ),
          alignBtn(
            "selection:right",
            "Right",
            "Align right edges of selection",
            !canCompose
          ),
        ])
      );
      section.appendChild(
        el("div", { className: "editor-props-align-row" }, [
          alignBtn(
            "selection:top",
            "Top",
            "Align top edges of selection",
            !canCompose
          ),
          alignBtn(
            "selection:vcenter",
            "Middle",
            "Align vertical middles of selection",
            !canCompose
          ),
          alignBtn(
            "selection:bottom",
            "Bottom",
            "Align bottom edges of selection",
            !canCompose
          ),
        ])
      );
      section.appendChild(
        el("p", {
          className: "editor-props-align-heading",
          text: "Distribute",
        })
      );
      section.appendChild(
        el("div", { className: "editor-props-align-row" }, [
          distributeBtn(
            "horizontal",
            "Dist ↔",
            count >= 3
              ? "Distribute selected objects evenly horizontally"
              : "Select at least 3 objects to distribute horizontally",
            !canDistribute
          ),
          distributeBtn(
            "vertical",
            "Dist ↕",
            count >= 3
              ? "Distribute selected objects evenly vertically"
              : "Select at least 3 objects to distribute vertically",
            !canDistribute
          ),
        ])
      );
      section.appendChild(
        el("p", {
          className: "editor-props-align-heading",
          text: "Center on canvas",
        })
      );
      section.appendChild(
        el("div", { className: "editor-props-align-row" }, [
          centerBtn(
            "horizontal",
            "Canvas ↔",
            "Center selection horizontally on the canvas (keeps arrangement)",
            !canCompose
          ),
          centerBtn(
            "vertical",
            "Canvas ↕",
            "Center selection vertically on the canvas (keeps arrangement)",
            !canCompose
          ),
          centerBtn(
            "both",
            "Center",
            "Center selection on the canvas (keeps relative arrangement)",
            !canCompose
          ),
        ])
      );
    } else {
      section.appendChild(
        el("p", {
          className: "editor-props-align-heading",
          text: "Align to canvas",
        })
      );
      section.appendChild(
        el("div", { className: "editor-props-align-row" }, [
          alignBtn(
            "canvas:left",
            "Left",
            "Align to left edge of canvas",
            !canCompose
          ),
          alignBtn(
            "canvas:hcenter",
            "Center",
            "Center horizontally on canvas",
            !canCompose
          ),
          alignBtn(
            "canvas:right",
            "Right",
            "Align to right edge of canvas",
            !canCompose
          ),
        ])
      );
      section.appendChild(
        el("div", { className: "editor-props-align-row" }, [
          alignBtn(
            "canvas:top",
            "Top",
            "Align to top edge of canvas",
            !canCompose
          ),
          alignBtn(
            "canvas:vcenter",
            "Middle",
            "Center vertically on canvas",
            !canCompose
          ),
          alignBtn(
            "canvas:bottom",
            "Bottom",
            "Align to bottom edge of canvas",
            !canCompose
          ),
        ])
      );
    }
    section.appendChild(
      el("p", { className: "editor-props-align-heading", text: "Flip" })
    );
    section.appendChild(
      el("div", { className: "editor-props-align-row" }, [
        flipBtn("horizontal", "Flip H", "Flip horizontally", !canCompose),
        flipBtn("vertical", "Flip V", "Flip vertically", !canCompose),
      ])
    );
    return section;
  }

  function readCurveUiFromObject(obj) {
    var curve = obj && obj.blytzCurve;
    var amount =
      curve && typeof curve.amount === "number" ? curve.amount : obj && obj.path ? 0.5 : 0;
    var direction =
      curve && curve.direction === "down" ? "down" : "up";
    var enabled = !!(obj && obj.path) || !!(curve && amount > 0.001);
    return {
      enabled: enabled,
      amountPct: Math.round(Math.max(0, Math.min(1, amount)) * 100),
      direction: direction,
    };
  }

  function curveSupportsObject(obj) {
    var a = api();
    if (!obj || !a) return false;
    if (a.isActiveSelection && a.isActiveSelection(obj)) return false;
    if (!isTextType(obj)) return false;
    if (a.textHasMultipleLines && a.textHasMultipleLines(obj)) return false;
    return true;
  }

  function discardCurvePreview() {
    if (!curveSession) return false;
    var a = api();
    var cnv = canvas();
    var session = curveSession;
    curveSession = null;
    if (!a || !cnv || !session.baseline) return true;
    var obj = null;
    var objects = cnv.getObjects ? cnv.getObjects() : [];
    for (var i = 0; i < objects.length; i++) {
      if (objects[i] && objects[i].blytzId === session.objectId) {
        obj = objects[i];
        break;
      }
    }
    if (!obj) return true;
    var b = session.baseline;
    a.previewTextCurveOnObject(obj, {
      enabled: b.enabled,
      amount: b.amountPct / 100,
      direction: b.direction,
    });
    // Restore transforms in case path layout shifted the box.
    a.runSilent(function () {
      obj.set({
        left: b.left,
        top: b.top,
        scaleX: b.scaleX,
        scaleY: b.scaleY,
        angle: b.angle,
      });
      if (typeof obj.setCoords === "function") obj.setCoords();
      cnv.requestRenderAll();
      return true;
    });
    // Stage G: preview discarded — recompute dirty vs last saved (no false unsaved).
    if (
      global.BlytzEditorSaveState &&
      typeof global.BlytzEditorSaveState.recompute === "function"
    ) {
      try {
        global.BlytzEditorSaveState.recompute();
      } catch (err) {
        /* ignore */
      }
    }
    return true;
  }

  function ensureCurveSession(obj) {
    if (!obj || !obj.blytzId) return null;
    if (curveSession && curveSession.objectId === obj.blytzId) {
      return curveSession;
    }
    if (curveSession) discardCurvePreview();
    var ui = readCurveUiFromObject(obj);
    curveSession = {
      objectId: obj.blytzId,
      baseline: {
        enabled: ui.enabled,
        amountPct: ui.amountPct,
        direction: ui.direction,
        left: obj.left,
        top: obj.top,
        scaleX: obj.scaleX,
        scaleY: obj.scaleY,
        angle: obj.angle || 0,
      },
      draft: {
        enabled: ui.enabled,
        amountPct: ui.amountPct,
        direction: ui.direction,
      },
      dirty: false,
    };
    return curveSession;
  }

  function updateCurvePanelChrome(body, session) {
    if (!body || !session) return;
    var enabled = !!session.draft.enabled;
    var slider = body.querySelector('[data-curve-amount]');
    var out = body.querySelector("[data-curve-amount-out]");
    var enable = body.querySelector('[data-curve-enable]');
    var status = body.querySelector("[data-curve-status]");
    var applyBtn = body.querySelector("[data-curve-apply]");
    var cancelBtn = body.querySelector("[data-curve-cancel]");
    if (enable) enable.checked = enabled;
    if (slider) {
      slider.disabled = !enabled;
      slider.value = String(session.draft.amountPct);
    }
    if (out) out.textContent = String(session.draft.amountPct);
    body.querySelectorAll("[data-curve-direction]").forEach(function (btn) {
      var on =
        enabled &&
        btn.getAttribute("data-curve-direction") === session.draft.direction;
      btn.disabled = !enabled;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("is-active", on);
    });
    if (status) {
      if (!enabled || session.draft.amountPct < 1) {
        status.textContent = "Straight";
      } else {
        status.textContent =
          (session.draft.direction === "down" ? "Down" : "Up") +
          " · " +
          session.draft.amountPct +
          "%";
      }
      if (session.dirty) status.textContent += " (preview)";
    }
    if (applyBtn) applyBtn.disabled = !session.dirty;
    if (cancelBtn) cancelBtn.disabled = !session.dirty;
  }

  function runCurvePreview(obj, session) {
    var a = api();
    if (!a || !obj || !session) return;
    a.previewTextCurveOnObject(obj, {
      enabled: session.draft.enabled && session.draft.amountPct > 0,
      amount: session.draft.amountPct / 100,
      direction: session.draft.direction,
    });
  }

  function buildTextCurveControls(obj) {
    var unsupported =
      api() &&
      api().textHasMultipleLines &&
      api().textHasMultipleLines(obj);
    var section = el("div", {
      className: "editor-props-curve",
      "data-curve-section": "1",
    });
    section.appendChild(
      el("p", { className: "editor-props-align-heading", text: "Curve text" })
    );
    if (unsupported) {
      section.appendChild(
        el("p", {
          className: "editor-props-readonly",
          text: "Curved text supports single-line text only.",
        })
      );
      return section;
    }
    var session = ensureCurveSession(obj);
    var enableLab = el("label", { className: "editor-props-check-label" });
    var enable = el("input", {
      type: "checkbox",
      className: "editor-props-check",
      "data-curve-enable": "1",
    });
    enable.checked = session.draft.enabled;
    enableLab.appendChild(enable);
    enableLab.appendChild(document.createTextNode(" Enable curve"));
    section.appendChild(el("div", { className: "editor-props-row" }, [enableLab]));

    var amountRange = el("input", {
      type: "range",
      className: "editor-props-range",
      "data-curve-amount": "1",
      min: "0",
      max: "100",
      step: "1",
      value: String(session.draft.amountPct),
    });
    var amountOut = el("span", {
      className: "editor-props-range-val",
      "data-curve-amount-out": "1",
      text: String(session.draft.amountPct),
    });
    section.appendChild(
      labeledRow(
        "Curvature",
        el("div", { className: "editor-props-range-wrap" }, [
          amountRange,
          amountOut,
        ]),
        "%"
      )
    );

    var dirGroup = el("div", {
      className: "editor-props-align-row",
      role: "group",
      "aria-label": "Curve direction",
    });
    ["up", "down"].forEach(function (dir) {
      var btn = el("button", {
        type: "button",
        className: "editor-props-align-btn",
        "data-curve-direction": dir,
        text: dir === "up" ? "Upward" : "Downward",
        title: dir === "up" ? "Curve upward" : "Curve downward",
        "aria-label": dir === "up" ? "Curve upward" : "Curve downward",
        "aria-pressed": "false",
      });
      dirGroup.appendChild(btn);
    });
    section.appendChild(labeledRow("Direction", dirGroup));

    section.appendChild(
      el("p", {
        className: "editor-props-curve-status",
        "data-curve-status": "1",
        text: "Straight",
      })
    );

    var actions = el("div", { className: "editor-props-curve-actions" });
    actions.appendChild(
      el("button", {
        type: "button",
        className: "editor-props-align-btn editor-props-curve-apply",
        "data-curve-apply": "1",
        text: "Apply",
        "aria-label": "Apply curve",
      })
    );
    actions.appendChild(
      el("button", {
        type: "button",
        className: "editor-props-align-btn",
        "data-curve-cancel": "1",
        text: "Cancel",
        "aria-label": "Cancel curve preview",
      })
    );
    section.appendChild(actions);
    updateCurvePanelChrome(section, session);
    return section;
  }

  function clearPropertiesBody() {
    var body = bodyEl();
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    body.removeAttribute("data-sync-for");
  }

  /**
   * Drop curve preview + session when selection no longer matches the draft target.
   * Safe to call when panel is hidden (deselection must not leave Apply/Cancel live).
   */
  function discardCurveSessionIfStale(obj) {
    if (!curveSession) return;
    if (!obj || !obj.blytzId || obj.blytzId !== curveSession.objectId) {
      discardCurvePreview();
    }
  }

  function setPropsControlsDisabled(root, disabled) {
    if (!root) return;
    root.querySelectorAll("input, select, textarea, button").forEach(function (node) {
      if (node.getAttribute("data-props-close") != null) return;
      if (node.getAttribute("data-props-expand") != null) return;
      node.disabled = !!disabled;
    });
  }

    /* ---- Redesign helpers ---- */
  var PROPS_TITLES = {
    rect: "Rectangle",
    ellipse: "Ellipse",
    polygon: "Shape",
    path: "Shape",
    line: "Line",
    itext: "Text",
    text: "Text",
    textbox: "Text",
    image: "Image",
    activeselection: "Selection",
  };

  function setPropsTitle(obj) {
    var t = document.getElementById("editor-properties-title");
    if (!t) return;
    t.textContent = (obj && PROPS_TITLES[typeKey(obj)]) || "Properties";
  }

  function propsSection(title) {
    var s = el("section", { className: "editor-props-section" });
    s.appendChild(el("h3", { className: "editor-props-section-title", text: title }));
    return s;
  }

  /** Number input with a unit label inside the field (px, °). */
  function unitField(key, value, step, unit, ariaLabel, minVal) {
    var input = numberInput(key, value, step);
    if (ariaLabel) input.setAttribute("aria-label", ariaLabel);
    if (minVal != null) input.setAttribute("min", String(minVal));
    var wrap = el("div", { className: "editor-props-field" }, [input]);
    if (unit) wrap.appendChild(el("span", { className: "editor-props-unit", text: unit }));
    return wrap;
  }

  function miniField(labelText, control) {
    return el("div", { className: "editor-props-mini" }, [
      el("span", { className: "editor-props-mini-label", text: labelText }),
      control,
    ]);
  }

  function pairRow(children) {
    return el("div", { className: "editor-props-pair" }, children);
  }

    function buildControls(obj) {
    var body = bodyEl();
    if (!body) return;
    // Drop preview if controls rebuild for a different selection.
    discardCurveSessionIfStale(obj);
    while (body.firstChild) body.removeChild(body.firstChild);
    body.removeAttribute("data-sync-for");
    setPropsTitle(obj);

    if (!obj) return;

    if (typeKey(obj) === "activeselection") {
      var n = (obj.getObjects && obj.getObjects().length) || 0;
      var multiLocked = selectionHasLocked(obj);
      body.appendChild(
        el("p", {
          className: "editor-props-readonly",
          text: n + " objects selected",
        })
      );
      body.appendChild(
        buildAlignFlipControls({
          isMulti: true,
          count: n,
          locked: multiLocked,
        })
      );
      return;
    }

    var locked = !!(api() && api().isObjectLocked && api().isObjectLocked(obj));
    if (locked) {
      body.appendChild(
        el("p", {
          className: "editor-props-readonly",
          text: "Locked — unlock in Layers to edit",
        })
      );
    }

    var keys = PROPERTY_REGISTRY[typeKey(obj)] || [];
    var center = obj.getCenterPoint();
    var renderedW = obj.getScaledWidth();
    var renderedH = obj.getScaledHeight();
    var isImage = typeKey(obj) === "image";
    var sizeMin = limits().sizeMin != null ? limits().sizeMin : 8;

    // Card sections (appended in a fixed order after the loop)
    var textSec = propsSection("Text");
    var lookSec = propsSection("Appearance");
    var layoutSec = propsSection("Position & size");
    var borderSec = propsSection("Border");
    var posFields = [];
    var sizeFields = [];
    var rotRow = null;
    var keepRow = null;
    var curveSec = null;
    var placeSec = null;

    keys.forEach(function (key) {
      if (key === "fill") {
        lookSec.appendChild(labeledRow("Fill", buildColorControl("fill", obj.fill)));
        
      } else if (key === "strokeStyle") {
        borderSec.appendChild(buildBorderStyleControl(obj));
      } else if (key === "stroke") {
        var strokeRow = labeledRow(
          "Border color",
          buildColorControl("stroke", obj.stroke || lastStrokeColor)
        );
        strokeRow.setAttribute("data-stroke-color-row", "1");
        strokeRow.hidden = strokeStyleOf(obj) === "none"; // no border = no colour
        borderSec.appendChild(strokeRow);
      } else if (key === "cornerRadius") {
        if (typeKey(obj) === "rect") borderSec.appendChild(buildCornerControl(obj));

      } else if (key === "opacity") {
        var opPct = Math.round((obj.opacity == null ? 1 : obj.opacity) * 100);
        var range = el("input", {
          type: "range",
          className: "editor-props-range",
          "data-prop": "opacity",
          min: "0",
          max: "100",
          step: "1",
          value: String(opPct),
          "aria-label": "Opacity percent",
        });
        var out = el("span", {
          className: "editor-props-range-val",
          "data-prop-out": "opacity",
          text: opPct + "%",
        });
        var opNum = el("input", {
          type: "number",
          className: "editor-props-input editor-props-opacity-num",
          "data-prop": "opacity",
          min: "0",
          max: "100",
          step: "1",
          value: String(opPct),
          "aria-label": "Opacity percent numeric",
        });
        var opField = el("div", { className: "editor-props-field editor-props-opacity-field" }, [
          opNum,
          el("span", { className: "editor-props-unit", text: "%" }),
        ]);
        var wrap = el("div", { className: "editor-props-range-wrap" }, [
          range,
          out,
          opField,
        ]);
        lookSec.appendChild(labeledRow("Opacity", wrap));
      } else if (key === "posX") {
        posFields.push(
          miniField("X", unitField("posX", center.x, 1, "px", "Position X"))
        );
      } else if (key === "posY") {
        posFields.push(
          miniField("Y", unitField("posY", center.y, 1, "px", "Position Y"))
        );
      } else if (key === "width") {
        var wLabel = typeKey(obj) === "line" ? "Length" : "Width";
        sizeFields.push(
          miniField(
            wLabel,
            unitField("width", renderedW, 1, "px", wLabel + " in canvas pixels", sizeMin)
          )
        );
      } else if (key === "height") {
        sizeFields.push(
          miniField(
            "Height",
            unitField("height", renderedH, 1, "px", "Height in canvas pixels", sizeMin)
          )
        );
      } else if (key === "rotation") {
        var rotWrap = el("div", { className: "editor-props-rot-wrap" }, [
          unitField("rotation", obj.angle || 0, 1, "°", "Rotation in degrees"),
        ]);
        if (isImage) {
          var resetBtn = el("button", {
            type: "button",
            className: "editor-props-align-btn editor-props-rot-reset",
            "data-image-place": "reset-rotation",
            text: "0°",
            title: "Reset rotation to 0°",
            "aria-label": "Reset rotation to zero degrees",
          });
          if (locked) resetBtn.disabled = true;
          rotWrap.appendChild(resetBtn);
        }
        rotRow = labeledRow("Rotation", rotWrap);
      } else if (key === "imagePlacement") {
        if (isImage) placeSec = buildImagePlacementControls(locked);
      } else if (key === "fontSize") {
        textSec.appendChild(
          labeledRow(
            "Font size",
            unitField("fontSize", obj.fontSize || 16, 1, "px", "Font size")
          )
        );
      } else if (key === "textStyle") {
        textSec.appendChild(labeledRow("Style", buildTextStyleControls(obj)));
      } else if (key === "textAlign") {
        var alignGroup = el("div", {
          className: "editor-props-align-row",
          role: "group",
          "aria-label": "Text alignment",
        });
        ["left", "center", "right"].forEach(function (align) {
          var btn = el("button", {
            type: "button",
            className: "editor-props-align-btn",
            "data-prop": "textAlign",
            "data-text-align": align,
            text: align.charAt(0).toUpperCase() + align.slice(1),
            title: "Align text " + align,
            "aria-label": "Align text " + align,
            "aria-pressed":
              normalizeTextAlign(obj.textAlign) === align ? "true" : "false",
          });
          if (normalizeTextAlign(obj.textAlign) === align) {
            btn.classList.add("is-active");
          }
          alignGroup.appendChild(btn);
        });
        textSec.appendChild(labeledRow("Alignment", alignGroup));
      } else if (key === "charSpacing") {
        var csVal = obj.charSpacing == null ? 0 : obj.charSpacing;
        var csRange = el("input", {
          type: "range",
          className: "editor-props-range",
          "data-prop": "charSpacing",
          min: String(limits().charSpacingMin != null ? limits().charSpacingMin : -200),
          max: String(limits().charSpacingMax != null ? limits().charSpacingMax : 800),
          step: "10",
          value: String(csVal),
        });
        var csOut = el("span", {
          className: "editor-props-range-val",
          "data-prop-out": "charSpacing",
          text: String(Math.round(csVal)),
        });
        textSec.appendChild(
          labeledRow(
            "Letter spacing",
            el("div", { className: "editor-props-range-wrap" }, [csRange, csOut])
          )
        );
      } else if (key === "lineHeight") {
        var lhVal = obj.lineHeight == null ? 1.16 : obj.lineHeight;
        var lhRange = el("input", {
          type: "range",
          className: "editor-props-range",
          "data-prop": "lineHeight",
          min: String(limits().lineHeightMin != null ? limits().lineHeightMin : 0.8),
          max: String(limits().lineHeightMax != null ? limits().lineHeightMax : 2.5),
          step: "0.05",
          value: String(Math.round(lhVal * 100) / 100),
        });
        var lhOut = el("span", {
          className: "editor-props-range-val",
          "data-prop-out": "lineHeight",
          text: String(Math.round(lhVal * 100) / 100),
        });
        textSec.appendChild(
          labeledRow(
            "Line spacing",
            el("div", { className: "editor-props-range-wrap" }, [lhRange, lhOut])
          )
        );
      } else if (key === "textCurve") {
        curveSec = buildTextCurveControls(obj);
      } else if (key === "fontFamily") {
        var sel = el("select", {
          className: "editor-props-input",
          "data-prop": "fontFamily",
        });
        fonts().forEach(function (f) {
          var opt = el("option", { value: f, text: f });
          if (f === obj.fontFamily) opt.selected = true;
          sel.appendChild(opt);
        });
        textSec.appendChild(labeledRow("Font", sel));
      } else if (key === "text") {
        var ta = el("textarea", {
          className: "editor-props-textarea",
          "data-prop": "text",
          rows: "3",
          maxlength: String(limits().textMax || 200),
        });
        ta.value = obj.text || "";
        textSec.appendChild(labeledRow("Content", ta));
      } else if (key === "keepProportions") {
        var chk = el("input", {
          type: "checkbox",
          className: "editor-props-check",
          "data-prop": "keepProportions",
          "aria-label": "Lock aspect ratio",
        });
        chk.checked = keepProportions;
        var lab = el("label", { className: "editor-props-check-label" });
        lab.appendChild(chk);
        lab.appendChild(
          document.createTextNode(
            keepProportions ? " Aspect ratio locked" : " Aspect ratio unlocked"
          )
        );
        keepRow = el("div", { className: "editor-props-row" }, [lab]);
      }
    });

    // Assemble the Position & size card
    if (posFields.length) layoutSec.appendChild(pairRow(posFields));
    if (sizeFields.length) layoutSec.appendChild(pairRow(sizeFields));
    if (rotRow) layoutSec.appendChild(rotRow);
    if (keepRow) layoutSec.appendChild(keepRow);

    // Append cards in a fixed order (skip empty ones: only the title inside)
    [textSec, lookSec, borderSec, curveSec, layoutSec, placeSec].forEach(function (sec) {
      if (sec && sec.childNodes.length > 1) body.appendChild(sec);
    });

    body.appendChild(
      buildAlignFlipControls({ isMulti: false, count: 1, locked: locked })
    );
    if (locked) setPropsControlsDisabled(body, true);

    body.querySelectorAll("[data-auto-layout-selected]").forEach(function (btn) {
      var currentApi = api();
      var allow = !!(
        currentApi &&
        currentApi.canAutoLayoutSelected &&
        currentApi.canAutoLayoutSelected()
      );

      btn.disabled = !allow;
    });
  }

  function buildTextStyleControls(obj) {
    var group = el("div", {
      className: "editor-props-align-row editor-props-style-row",
      role: "group",
      "aria-label": "Text style",
    });
    var styles = [
      {
        id: "bold",
        prop: "fontWeight",
        label: "B",
        title: "Bold",
        active: isBoldWeight(obj.fontWeight),
        className: "editor-props-style-btn is-bold",
      },
      {
        id: "italic",
        prop: "fontStyle",
        label: "I",
        title: "Italic",
        active: isItalicStyle(obj.fontStyle),
        className: "editor-props-style-btn is-italic",
      },
      {
        id: "underline",
        prop: "underline",
        label: "U",
        title: "Underline",
        active: isUnderlined(obj.underline),
        className: "editor-props-style-btn is-underline",
      },
    ];
    styles.forEach(function (spec) {
      var btn = el("button", {
        type: "button",
        className: "editor-props-align-btn " + spec.className,
        "data-prop": spec.prop,
        "data-text-style": spec.id,
        text: spec.label,
        title: spec.title,
        "aria-label": spec.title,
        "aria-pressed": spec.active ? "true" : "false",
      });
      if (spec.active) btn.classList.add("is-active");
      group.appendChild(btn);
    });
    return group;
  }

  function toggleTextStyle(obj, styleId) {
    if (!obj || !isTextType(obj)) return false;
    if (styleId === "bold") {
      return commitField(
        obj,
        "fontWeight",
        isBoldWeight(obj.fontWeight) ? "normal" : "bold"
      );
    }
    if (styleId === "italic") {
      return commitField(
        obj,
        "fontStyle",
        isItalicStyle(obj.fontStyle) ? "normal" : "italic"
      );
    }
    if (styleId === "underline") {
      return commitField(obj, "underline", !isUnderlined(obj.underline));
    }
    return false;
  }

  function patchTextStyleButtons(body, obj) {
    if (!body || !obj) return;
    var map = {
      bold: isBoldWeight(obj.fontWeight),
      italic: isItalicStyle(obj.fontStyle),
      underline: isUnderlined(obj.underline),
    };
    body.querySelectorAll("[data-text-style]").forEach(function (btn) {
      var id = btn.getAttribute("data-text-style");
      var on = !!map[id];
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("is-active", on);
    });
  }

  function runCurvePanelClick(e) {
    var a = api();
    if (!a) return false;
    var applyBtn = e.target.closest("[data-curve-apply]");
    var cancelBtn = e.target.closest("[data-curve-cancel]");
    var dirBtn = e.target.closest("[data-curve-direction]");
    if (!applyBtn && !cancelBtn && !dirBtn) return false;
    e.preventDefault();
    var obj = activeObject();
    // Stale DOM after deselect / multi-select / non-text must not mutate a prior object.
    if (
      !curveSupportsObject(obj) ||
      !curveSession ||
      !obj.blytzId ||
      obj.blytzId !== curveSession.objectId
    ) {
      discardCurvePreview();
      return true;
    }
    if (a.isObjectLocked && a.isObjectLocked(obj)) return true;
    var body = bodyEl();
    if (cancelBtn) {
      discardCurvePreview();
      // Recreate session from restored object so UI matches committed state.
      if (obj) ensureCurveSession(obj);
      if (body && curveSession) updateCurvePanelChrome(body, curveSession);
      scheduleSync();
      return true;
    }
    if (dirBtn) {
      if (!curveSession.draft.enabled) return true;
      curveSession.draft.direction = dirBtn.getAttribute("data-curve-direction") || "up";
      curveSession.dirty = true;
      runCurvePreview(obj, curveSession);
      updateCurvePanelChrome(body, curveSession);
      return true;
    }
    if (applyBtn) {
      if (!curveSession.dirty) return true;
      var draft = {
        enabled: curveSession.draft.enabled,
        amountPct: curveSession.draft.amountPct,
        direction: curveSession.draft.direction,
      };
      // Restore baseline silently, then one committed apply from clean history base.
      discardCurvePreview();
      var amount =
        draft.enabled && draft.amountPct > 0 ? draft.amountPct / 100 : 0;
      var ok = a.applyTextCurve(
        { amount: amount, direction: draft.direction },
        getJSON
      );
      curveSession = null;
      if (ok && obj) ensureCurveSession(obj);
      if (body && curveSession) {
        curveSession.dirty = false;
        updateCurvePanelChrome(body, curveSession);
      }
      scheduleSync();
      return true;
    }
    return false;
  }

  function selectionHasLocked(obj) {
    var a = api();
    if (!obj || !a) return false;
    if (a.isObjectLocked && a.isObjectLocked(obj)) return true;
    if (a.isActiveSelection && a.isActiveSelection(obj) && obj.getObjects) {
      var members = obj.getObjects();
      for (var i = 0; i < members.length; i++) {
        if (a.isObjectLocked(members[i])) return true;
      }
    }
    return false;
  }

  function runImagePlacementClick(e) {
    var a = api();
    if (!a) return false;
    var placeEl = e.target.closest("[data-image-place]");
    if (!placeEl) return false;
    e.preventDefault();
    var obj = activeObject();
    if (
      !obj ||
      typeKey(obj) !== "image" ||
      (a.isActiveSelection && a.isActiveSelection(obj)) ||
      selectionHasLocked(obj)
    ) {
      return true;
    }
    var action = placeEl.getAttribute("data-image-place");
    if (action === "center" && a.centerActiveImage) {
      a.centerActiveImage(getJSON);
    } else if (action === "fit" && a.fitActiveWithinCanvas) {
      a.fitActiveWithinCanvas(getJSON);
    } else if (action === "reset-rotation" && a.resetActiveRotation) {
      a.resetActiveRotation(getJSON);
    } else if (action === "remove-bg") {
      runRemoveBackground(getJSON);
    }
    scheduleSync();
    return true;
  }

  function runAlignFlipClick(e) {
    var a = api();
    if (!a) return;
    if (runCurvePanelClick(e)) return;
    if (runImagePlacementClick(e)) return;
    var strokeBtn = e.target.closest("[data-stroke-style]");
    if (strokeBtn) {
      e.preventDefault();
      var strokeObj = activeObject();
      if (
        !strokeObj ||
        (a.isActiveSelection && a.isActiveSelection(strokeObj)) ||
        selectionHasLocked(strokeObj)
      ) {
        return;
      }
      commitField(strokeObj, "strokeStyle", strokeBtn.getAttribute("data-stroke-style"));
      scheduleSync();
      return;
    }
    var layoutSelectedBtn = e.target.closest("[data-auto-layout-selected]");
    if (layoutSelectedBtn) {
      e.preventDefault();
      if (layoutSelectedBtn.disabled) return;

      if (a.autoLayoutSelected) {
        a.autoLayoutSelected(getJSON);
      }

      scheduleSync();
      return;
    }
    var styleBtn = e.target.closest("[data-text-style]");
    if (styleBtn) {
      e.preventDefault();
      var styleObj = activeObject();
      if (
        !styleObj ||
        !isTextType(styleObj) ||
        (a.isActiveSelection && a.isActiveSelection(styleObj)) ||
        selectionHasLocked(styleObj)
      ) {
        return;
      }
      toggleTextStyle(styleObj, styleBtn.getAttribute("data-text-style"));
      scheduleSync();
      return;
    }
    var textAlignBtn = e.target.closest("[data-text-align]");
    if (textAlignBtn) {
      e.preventDefault();
      var obj = activeObject();
      if (
        !obj ||
        !isTextType(obj) ||
        (a.isActiveSelection && a.isActiveSelection(obj)) ||
        selectionHasLocked(obj)
      ) {
        return;
      }
      commitField(obj, "textAlign", textAlignBtn.getAttribute("data-text-align"));
      scheduleSync();
      return;
    }
    var alignEl = e.target.closest("[data-align-action]");
    var centerEl = e.target.closest("[data-center-action]");
    var flipEl = e.target.closest("[data-flip-action]");
    var distEl = e.target.closest("[data-distribute-action]");
    if (alignEl || centerEl || flipEl || distEl) {
      if (alignEl && alignEl.disabled) return;
      if (centerEl && centerEl.disabled) return;
      if (flipEl && flipEl.disabled) return;
      if (distEl && distEl.disabled) return;
      if (selectionHasLocked(activeObject())) return;
    }
    if (alignEl) {
      e.preventDefault();
      var raw = alignEl.getAttribute("data-align-action") || "";
      var parts = raw.split(":");
      var mode = parts[0];
      var direction = parts[1];
      if (mode === "canvas" || mode === "selection") {
        a.alignActive(direction, mode, getJSON);
      }
      scheduleSync();
      return;
    }
    if (distEl) {
      e.preventDefault();
      if (a.distributeActive) {
        a.distributeActive(distEl.getAttribute("data-distribute-action"), getJSON);
      }
      scheduleSync();
      return;
    }
    if (centerEl) {
      e.preventDefault();
      a.centerOnCanvas(centerEl.getAttribute("data-center-action"), getJSON);
      scheduleSync();
      return;
    }
    if (flipEl) {
      e.preventDefault();
      a.flipActive(flipEl.getAttribute("data-flip-action"), getJSON);
      scheduleSync();
    }
  }

  function activeObject() {
    var c = canvas();
    return c ? c.getActiveObject() : null;
  }

  function updateVisibility() {
    var panel = panelEl();
    var pill = pillEl();
    var obj = activeObject();
    var has = !!obj;
    var narrow = isNarrowProps();
    var mobile = isMobileToolbar();
    var expandBtn = panel && panel.querySelector("[data-props-expand]");
    var closeBtn = panel && panel.querySelector("[data-props-close]");

    if (!panel) return;

    if (!has) {
      panel.hidden = true;
      panel.classList.remove("is-open", "is-collapsed");
      sheetOpen = false;
      forceClosed = false; // <-- ADD THIS (resets when you click empty canvas)
      if (pill) pill.hidden = true;
      return;
    }

    if (forceClosed) { // <-- ADD THIS BLOCK
      panel.hidden = true;
      if (pill) pill.hidden = true;
      return;
    }

    if (!panel) return;

    if (!has) {
      panel.hidden = true;
      panel.classList.remove("is-open", "is-collapsed");
      sheetOpen = false;
      if (pill) pill.hidden = true;
      return;
    }

    if (narrow) {
      // <=1279: sheet vs tool panels are mutually exclusive.
      // <=1023: Edit pill gates the sheet. 1024–1279: no pill; sheetOpen drives visibility.
      if (isToolPanelOpen()) {
        sheetOpen = false;
      }
      if (mobile) {
        if (pill) {
          pill.hidden = false;
          pill.setAttribute("aria-expanded", sheetOpen ? "true" : "false");
        }
      } else if (pill) {
        pill.hidden = true;
      }
      if (sheetOpen) {
        panel.hidden = false;
        panel.classList.add("is-open");
        panel.classList.remove("is-collapsed");
      } else {
        panel.hidden = true;
        panel.classList.remove("is-open");
      }
      if (expandBtn) expandBtn.hidden = true;
      if (closeBtn) closeBtn.setAttribute("aria-label", "Close properties");
    } else {
      if (pill) pill.hidden = true;
      panel.hidden = false;
      panel.classList.add("is-open");
      panel.classList.toggle("is-collapsed", collapsed);
      sheetOpen = true;
      if (expandBtn) expandBtn.hidden = !collapsed;
      if (closeBtn) {
        closeBtn.hidden = !!collapsed;
        closeBtn.setAttribute("aria-label", "Collapse properties");
      }
    }
  }

  function openSheet() {
    forceClosed = false;
    if (isNarrowProps() && global.BlytzEditorTools && BlytzEditorTools.closePanel) {
      BlytzEditorTools.closePanel();
    }
    sheetOpen = true;
    updateVisibility();
    syncFromSelection();
  }

  function closeSheet() {
    sheetOpen = false;
    updateVisibility();
  }

  function onToolPanelOpening() {
    if (isNarrowProps()) {
      closeSheet();
    }
  }

  function scheduleSync() {
    if (rafId) return;
    rafId = requestAnimationFrame(function () {
      rafId = 0;
      syncFromSelection();
    });
  }

  function syncFromSelection() {
    if (syncing) return;
    syncing = true;
    try {
      updateVisibility();
      var obj = activeObject();
      var panel = panelEl();
      var body = bodyEl();

      // Always discard preview when selection leaves the draft target (incl. deselect).
      discardCurveSessionIfStale(obj);

      // No selection: clear body even if panel is already hidden (stale Apply/Cancel).
      if (!obj) {
        clearPropertiesBody();
        return;
      }

      // Panel hidden (narrow + tool panel, or closed sheet): strip actionable controls
      // so orphaned DOM cannot mutate a previous object when re-shown incorrectly.
      if (!panel || panel.hidden) {
        clearPropertiesBody();
        return;
      }

      // Rebuild when type/selection identity or lock state changes; otherwise patch.
      var marker = body && body.getAttribute("data-sync-for");
      var lockedBit =
        api() && api().isObjectLocked && api().isObjectLocked(obj) ? "1" : "0";
      var id =
        (obj.blytzId || typeKey(obj) + ":" + (obj.text || "")) + ":L" + lockedBit;
      if (!body || marker !== String(id) || typeKey(obj) === "activeselection") {
        buildControls(obj);
        body = bodyEl();
        if (body && id != null) body.setAttribute("data-sync-for", String(id));
      } else {
        patchValues(obj);
        if (curveSession && body && !curveSession.dirty) {
          // Refresh chrome from object when not mid-preview.
          var ui = readCurveUiFromObject(obj);
          curveSession.baseline = {
            enabled: ui.enabled,
            amountPct: ui.amountPct,
            direction: ui.direction,
            left: obj.left,
            top: obj.top,
            scaleX: obj.scaleX,
            scaleY: obj.scaleY,
            angle: obj.angle || 0,
          };
          curveSession.draft = {
            enabled: ui.enabled,
            amountPct: ui.amountPct,
            direction: ui.direction,
          };
          updateCurvePanelChrome(body, curveSession);
        }
      }
    } finally {
      syncing = false;
    }
  }

  function patchValues(obj) {
    if (!obj || typeKey(obj) === "activeselection") return;
    var body = bodyEl();
    if (!body) return;
    var center = obj.getCenterPoint();
    var map = {
      posX: center.x,
      posY: center.y,
      width: obj.getScaledWidth(),
      height: obj.getScaledHeight(),
      rotation: obj.angle || 0,
      strokeWidth: obj.strokeWidth || 0,
      fontSize: obj.fontSize,
      opacity: Math.round((obj.opacity == null ? 1 : obj.opacity) * 100),
    };
    Object.keys(map).forEach(function (k) {
      var inputs = body.querySelectorAll('[data-prop="' + k + '"]');
      if (!inputs.length) return;
      inputs.forEach(function (input) {
        if (document.activeElement === input) return;
        if (k === "opacity") {
          input.value = String(map[k]);
        } else if (map[k] != null && !isNaN(map[k])) {
          input.value = String(Math.round(map[k] * 1000) / 1000);
        }
      });
      if (k === "opacity") {
        var out = body.querySelector('[data-prop-out="opacity"]');
        if (out) out.textContent = map[k] + "%";
      }
    });
    var aspectLab = body.querySelector('[data-prop="keepProportions"]');
    if (aspectLab && aspectLab.parentNode) {
      aspectLab.checked = keepProportions;
      var aspectText = aspectLab.parentNode;
      if (aspectText && aspectText.childNodes.length > 1) {
        aspectText.childNodes[1].textContent = keepProportions
          ? " Aspect ratio locked"
          : " Aspect ratio unlocked";
      }
    }
    var fill = body.querySelector('[data-prop="fill"]');
    if (fill && document.activeElement !== fill) fill.value = colorToHex(obj.fill);
    var stroke = body.querySelector('[data-prop="stroke"]');
    if (stroke && document.activeElement !== stroke) {
      stroke.value = colorToHex(obj.stroke || "#000000");
    }
    var font = body.querySelector('[data-prop="fontFamily"]');
    if (font && document.activeElement !== font && obj.fontFamily) {
      font.value = obj.fontFamily;
    }
    var text = body.querySelector('[data-prop="text"]');
    if (text && document.activeElement !== text) text.value = obj.text || "";
    patchTextStyleButtons(body, obj);
    var align = normalizeTextAlign(obj.textAlign);
    body.querySelectorAll("[data-text-align]").forEach(function (btn) {
      var on = btn.getAttribute("data-text-align") === align;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
      btn.classList.toggle("is-active", on);
    });
    var csInput = body.querySelector('[data-prop="charSpacing"]');
    if (csInput && document.activeElement !== csInput) {
      var csVal = obj.charSpacing == null ? 0 : obj.charSpacing;
      csInput.value = String(csVal);
      var csOut = body.querySelector('[data-prop-out="charSpacing"]');
      if (csOut) csOut.textContent = String(Math.round(csVal));
    }
    var lhInput = body.querySelector('[data-prop="lineHeight"]');
    if (lhInput && document.activeElement !== lhInput) {
      var lhVal = obj.lineHeight == null ? 1.16 : obj.lineHeight;
      lhInput.value = String(Math.round(lhVal * 100) / 100);
      var lhOut = body.querySelector('[data-prop-out="lineHeight"]');
      if (lhOut) lhOut.textContent = String(Math.round(lhVal * 100) / 100);
    }
    patchBorderControls(body, obj);
  }

  function parseNumber(raw) {
    if (raw === "" || raw == null) return NaN;
    return Number(raw);
  }

  function wirePanelEvents() {
    var panel = panelEl();
    if (!panel) return;

    panel.addEventListener("click", runAlignFlipClick);

    panel.addEventListener("pointerdown", function (e) {
      var obj = activeObject();
      var target = e.target.closest("[data-prop]");
      if (!target || !obj) return;
      var key = target.getAttribute("data-prop");
      if (target.type === "range" || target.type === "color") {
        beginLive(obj, key);
      }
    });

    // NEW: start a live session when the text-content field gains focus,
    // so typing is rendered immediately and the whole edit is ONE undo step.
    panel.addEventListener("focusin", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      if (t.getAttribute("data-prop") === "text") {
        beginLive(activeObject(), "text");
      }
    }, true);

    panel.addEventListener("change", function (e) {
      var enable = e.target.closest("[data-curve-enable]");
      if (!enable || syncing) return;
      var obj = activeObject();
      if (!curveSupportsObject(obj)) {
        discardCurvePreview();
        return;
      }
      if (api() && api().isObjectLocked && api().isObjectLocked(obj)) return;
      var session = ensureCurveSession(obj);
      if (!session || session.objectId !== obj.blytzId) return;
      session.draft.enabled = !!enable.checked;
      if (!session.draft.enabled) {
        session.draft.amountPct = 0;
      } else if (session.draft.amountPct < 1) {
        session.draft.amountPct = 40;
      }
      session.dirty = true;
      runCurvePreview(obj, session);
      updateCurvePanelChrome(bodyEl(), session);
    });

    panel.addEventListener("input", function (e) {
      var obj = activeObject();
      if (!obj || syncing) return;
      var t = e.target;
      if (t.getAttribute("data-curve-amount") != null) {
        if (!curveSupportsObject(obj)) {
          discardCurvePreview();
          return;
        }
        if (api() && api().isObjectLocked && api().isObjectLocked(obj)) return;
        var session = ensureCurveSession(obj);
        if (!session || session.objectId !== obj.blytzId) return;
        var pct = parseNumber(t.value);
        if (isNaN(pct)) return;
        pct = Math.max(0, Math.min(100, Math.round(pct)));
        session.draft.amountPct = pct;
        session.draft.enabled = pct > 0 ? true : session.draft.enabled;
        if (pct > 0) session.draft.enabled = true;
        session.dirty = true;
        runCurvePreview(obj, session);
        updateCurvePanelChrome(bodyEl(), session);
        return;
      }
      if (t.getAttribute("data-prop") === "keepProportions") {
        keepProportions = !!t.checked;
        var labNode = t.parentNode;
        if (labNode && labNode.childNodes.length > 1) {
          labNode.childNodes[1].textContent = keepProportions
            ? " Aspect ratio locked"
            : " Aspect ratio unlocked";
        }
        return;
      }
      var key = t.getAttribute("data-prop");
      if (!key) return;

      // NEW: live-render text edits as the user types.
      //   applyField → obj.set('text') + initDimensions + requestRenderAll
      //   (the safety check re-arms beginLive in case focusin was missed)
      if (key === "text") {
        if (liveKey !== "text" || !liveBaseline) {
          beginLive(obj, "text");
        }
        liveUpdate(obj, "text", t.value);
        return;
      }

      if ((key === "strokeWidth" || key === "cornerRadius") && t.type === "range") {
        var rv = parseNumber(t.value);
        if (!isNaN(rv)) liveUpdate(obj, key, rv);
        setRangeFill(t);
        patchBorderControls(bodyEl(), obj);
        return;
      }
      if (key === "opacity" && t.type === "range") {
        var pct = parseNumber(t.value);
        var out = panel.querySelector('[data-prop-out="opacity"]');
        if (out) out.textContent = (isNaN(pct) ? 0 : pct) + "%";
        var opNumLive = panel.querySelector(
          'input.editor-props-opacity-num[data-prop="opacity"]'
        );
        if (opNumLive && document.activeElement !== opNumLive) {
          opNumLive.value = String(isNaN(pct) ? 0 : pct);
        }
        if (!isNaN(pct)) liveUpdate(obj, "opacity", pct / 100);
        return;
      }
      if (key === "charSpacing" && t.type === "range") {
        var cs = parseNumber(t.value);
        var csOut = panel.querySelector('[data-prop-out="charSpacing"]');
        if (csOut) csOut.textContent = String(isNaN(cs) ? 0 : Math.round(cs));
        if (!isNaN(cs)) liveUpdate(obj, "charSpacing", cs);
        return;
      }
      if (key === "lineHeight" && t.type === "range") {
        var lh = parseNumber(t.value);
        var lhOut = panel.querySelector('[data-prop-out="lineHeight"]');
        if (lhOut) {
          lhOut.textContent = String(isNaN(lh) ? 1.16 : Math.round(lh * 100) / 100);
        }
        if (!isNaN(lh)) liveUpdate(obj, "lineHeight", lh);
        return;
      }
      if (t.type === "color") {
        liveUpdate(obj, key, t.value);
      }
    });

    panel.addEventListener("change", function (e) {
      var obj = activeObject();
      if (!obj || syncing) return;
      var t = e.target;
      var key = t.getAttribute("data-prop");
      if (!key || key === "keepProportions") return;

      if (t.type === "range" || t.type === "color") {
        endLive(obj, key);
        return;
      }
      if (key === "fontFamily") {
        commitField(obj, "fontFamily", t.value);
        return;
      }
      if (key === "text") return; // blur / ctrl+enter only
      var n = parseNumber(t.value);
      if (isNaN(n)) {
        scheduleSync();
        return;
      }
      if (key === "opacity") n = n / 100;
      commitField(obj, key, n);
    });

    panel.addEventListener("pointerup", function (e) {
      var t = e.target.closest("[data-prop]");
      if (!t) return;
      if (t.type === "range" || t.type === "color") {
        endLive(activeObject(), t.getAttribute("data-prop"));
      }
    });

    panel.addEventListener("blur", function (e) {
      var t = e.target;
      if (!t || !t.getAttribute) return;
      var key = t.getAttribute("data-prop");
      var obj = activeObject();
      if (!key || !obj || syncing) return;
      if (key === "text") {
        // Commit the whole typing session as a single edit; re-sync the
        // textarea from obj.text so rejected / clamped input is snapped back.
        endLive(obj, "text");
        return;
      }
      if (t.type === "number") {
        var n = parseNumber(t.value);
        if (isNaN(n)) {
          scheduleSync();
          return;
        }
        // Opacity UI is 0–100%; Fabric stores 0–1.
        var commitVal = key === "opacity" ? n / 100 : n;
        // change may already have committed; only commit if different
        var snap = readSnapshot(obj);
        // Compare against applying conceptually — if value already matches, skip
        if (key === "posX" && Math.abs(snap.cx - n) < 0.001) return;
        if (key === "posY" && Math.abs(snap.cy - n) < 0.001) return;
        if (key === "width" && Math.abs(snap.sw - n) < 0.001) return;
        if (key === "height" && Math.abs(snap.sh - n) < 0.001) return;
        if (key === "rotation" && Math.abs(normAngle(snap.angle) - normAngle(n)) < 0.001)
          return;
        if (key === "opacity" && Math.abs((snap.opacity == null ? 1 : snap.opacity) - commitVal) < 0.001)
          return;
        if (key === "strokeWidth" && snap.strokeWidth === n) return;
        if (key === "fontSize" && snap.fontSize === n) return;
        commitField(obj, key, commitVal);
      }
    }, true);

    panel.addEventListener("keydown", function (e) {
      var t = e.target;
      var key = t && t.getAttribute && t.getAttribute("data-prop");
      var obj = activeObject();
      if (!key || !obj) return;
      if (key === "text" && e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        t.blur();
        return;
      }
      if (t.type === "number" && e.key === "Enter") {
        e.preventDefault();
        t.blur();
      }
    });

    panel.addEventListener("click", function (e) {
      var sw = e.target.closest("[data-prop-swatch]");
      if (sw) {
        e.preventDefault();
        var obj = activeObject();
        var key = sw.getAttribute("data-prop-swatch");
        var color = sw.getAttribute("data-color");
        if (obj && key && color) commitField(obj, key, color);
        return;
      }
      if (e.target.closest("[data-props-close]")) {
        e.preventDefault();
        forceClosed = true;
        if (isNarrowProps()) closeSheet();
        else {
          collapsed = true;
          updateVisibility();
        }
        return;
      }
      if (e.target.closest("[data-props-expand]")) {
        e.preventDefault();
        collapsed = false;
        updateVisibility();
      }
    });
  }

  function wireCanvas() {
    var c = canvas();
    if (!c) return;
    ["selection:created", "selection:updated", "selection:cleared"].forEach(function (ev) {
      c.on(ev, function () {
        forceClosed = false;
        // Selection never commits / never discards AI by itself.
        if (!activeObject()) {
          sheetOpen = false;
        } else if (!isNarrowProps()) {
          sheetOpen = true;
          collapsed = false;
        } else if (isToolPanelOpen()) {
          // <=1279 + tool panel open: do not force the sheet on top.
          // Pill (≤1023) / selection chrome still update via scheduleSync.
        } else if (!isMobileToolbar()) {
          // 1024–1279 with no tool panel: auto-show properties sheet.
          sheetOpen = true;
        }
        // <=1023 with no tool panel: leave sheetOpen as-is (pill opens it).
        scheduleSync();
        if (global.BlytzEditorTools && BlytzEditorTools.refreshLayers) {
          BlytzEditorTools.refreshLayers();
        }
      });
    });
    c.on("object:modified", scheduleSync);
    ["object:moving", "object:scaling", "object:rotating"].forEach(function (ev) {
      c.on(ev, scheduleSync);
    });
    if (global.BlytzEditor && BlytzEditor.onCommittedChange) {
      BlytzEditor.onCommittedChange(function () {
        scheduleSync();
        if (global.BlytzEditorTools && BlytzEditorTools.refreshLayers) {
          BlytzEditorTools.refreshLayers();
        }
      });
    }
  }

  function wireChrome() {
    var pill = pillEl();
    if (pill) {
      pill.addEventListener("click", function (e) {
        e.preventDefault();
        if (sheetOpen) closeSheet();
        else openSheet();
      });
    }
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (isNarrowProps() && sheetOpen) {
        e.preventDefault();
        closeSheet();
        var p = pillEl();
        if (p) p.focus();
      }
    });
    window.addEventListener("resize", function () {
      updateVisibility();
    });
  }

  function init() {
    if (wired) return;
    wired = true;
    wireChrome();
    wirePanelEvents();
    // Canvas may not exist yet — retry shortly.
    var tries = 0;
    (function wait() {
      if (canvas()) {
        wireCanvas();
        syncFromSelection();
        return;
      }
      if (tries++ < 40) setTimeout(wait, 50);
    })();
  }

  global.BlytzEditorProps = {
    PROPERTY_REGISTRY: PROPERTY_REGISTRY,
    openSheet: openSheet,
    closeSheet: closeSheet,
    onToolPanelOpening: onToolPanelOpening,
    syncFromSelection: syncFromSelection,
    discardCurvePreview: discardCurvePreview,
    clearPropertiesBody: clearPropertiesBody,
    isCurvePreviewDirty: function () {
      return !!(curveSession && curveSession.dirty);
    },
    getCurveSessionObjectId: function () {
      return curveSession ? curveSession.objectId : null;
    },
    isSheetOpen: function () {
      return sheetOpen && panelEl() && !panelEl().hidden;
    },
  };

  document.addEventListener("DOMContentLoaded", init);
})(window);
