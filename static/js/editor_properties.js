/**
 * Stage 3c — floating Properties panel (registry-driven controls).
 * Mutations go through BlytzCanvas.runSilent (live) and commitEdit (commit).
 */
(function (global) {
  "use strict";

  var wired = false;
  var collapsed = false;
  var sheetOpen = false;
  var syncing = false;
  var rafId = 0;
  var keepProportions = true;
  var liveBaseline = null;
  var liveKey = null;

  /**
   * Property control registry: type → list of control ids.
   * Locking can later disable descriptors centrally.
   */
  var PROPERTY_REGISTRY = {
    rect: [
      "fill",
      "stroke",
      "strokeWidth",
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
      "stroke",
      "strokeWidth",
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
      "stroke",
      "strokeWidth",
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
      "stroke",
      "strokeWidth",
      "opacity",
      "posX",
      "posY",
      "width",
      "height",
      "rotation",
      "keepProportions",
    ],
    line: ["stroke", "strokeWidth", "opacity", "posX", "posY", "width", "rotation"],
    itext: ["text", "fill", "fontFamily", "fontSize", "opacity", "posX", "posY", "rotation"],
    text: ["text", "fill", "fontFamily", "fontSize", "opacity", "posX", "posY", "rotation"],
    textbox: ["text", "fill", "fontFamily", "fontSize", "opacity", "posX", "posY", "rotation"],
    image: ["opacity", "posX", "posY", "width", "height", "rotation", "keepProportions"],
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

  function readSnapshot(obj) {
    if (!obj) return null;
    var c = obj.getCenterPoint();
    var w = obj.getScaledWidth();
    var h = obj.getScaledHeight();
    return {
      fill: obj.fill,
      stroke: obj.stroke,
      strokeWidth: obj.strokeWidth,
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

  function applyField(obj, key, value, opts) {
    opts = opts || {};
    var L = limits();
    var cnv = canvas();
    if (!obj || !cnv) return false;

    if (key === "fill") {
      obj.set("fill", value);
    } else if (key === "stroke") {
      obj.set("stroke", value || null);
    } else if (key === "strokeWidth") {
      var sw = clamp(value, L.strokeWidthMin, L.strokeWidthMax);
      if (sw === null) return false;
      obj.set("strokeWidth", sw);
    } else if (key === "opacity") {
      var op = clamp(value, L.opacityMin, L.opacityMax);
      if (op === null) return false;
      obj.set("opacity", op);
    } else if (key === "rotation") {
      if (typeof value !== "number" || isNaN(value)) return false;
      obj.set("angle", normAngle(value));
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
      var size = clamp(value, L.sizeMin, L.sizeMax);
      if (size === null) return false;
      var baseW = obj.width || 1;
      var baseH = obj.height || 1;
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
      var sw = clamp(value, L.strokeWidthMin, L.strokeWidthMax);
      if (sw === null) return false;
      return !nearlyEqual(obj.strokeWidth == null ? 0 : obj.strokeWidth, sw);
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
      var sizeW = clamp(value, L.sizeMin, L.sizeMax);
      if (sizeW === null) return false;
      return !nearlyEqual(obj.getScaledWidth(), sizeW);
    }
    if (key === "height") {
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
    return false;
  }

  function commitField(obj, key, value, opts) {
    var a = api();
    if (!a || !obj) return false;
    if (a.isActiveSelection(obj)) return false;
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
    liveBaseline = readSnapshot(obj);
    liveKey = key;
  }

  function liveUpdate(obj, key, value, opts) {
    var a = api();
    if (!a || !obj) return;
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

  function buildControls(obj) {
    var body = bodyEl();
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);

    if (!obj) return;

    if (typeKey(obj) === "activeselection") {
      var n = (obj.getObjects && obj.getObjects().length) || 0;
      body.appendChild(
        el("p", {
          className: "editor-props-readonly",
          text: n + " objects selected",
        })
      );
      return;
    }

    var keys = PROPERTY_REGISTRY[typeKey(obj)] || [];
    var center = obj.getCenterPoint();
    var renderedW = obj.getScaledWidth();
    var renderedH = obj.getScaledHeight();

    keys.forEach(function (key) {
      if (key === "fill") {
        body.appendChild(labeledRow("Fill", buildColorControl("fill", obj.fill)));
      } else if (key === "stroke") {
        body.appendChild(
          labeledRow("Stroke", buildColorControl("stroke", obj.stroke || "#000000"))
        );
      } else if (key === "strokeWidth") {
        body.appendChild(
          labeledRow(
            "Stroke width",
            numberInput("strokeWidth", obj.strokeWidth || 0, 1),
            "px"
          )
        );
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
        });
        var out = el("span", {
          className: "editor-props-range-val",
          "data-prop-out": "opacity",
          text: opPct + "%",
        });
        var wrap = el("div", { className: "editor-props-range-wrap" }, [range, out]);
        body.appendChild(labeledRow("Opacity", wrap));
      } else if (key === "posX") {
        body.appendChild(labeledRow("Position X", numberInput("posX", center.x, 1), "px"));
      } else if (key === "posY") {
        body.appendChild(labeledRow("Position Y", numberInput("posY", center.y, 1), "px"));
      } else if (key === "width") {
        var wLabel = typeKey(obj) === "line" ? "Length" : "Width";
        body.appendChild(labeledRow(wLabel, numberInput("width", renderedW, 1), "px"));
      } else if (key === "height") {
        body.appendChild(labeledRow("Height", numberInput("height", renderedH, 1), "px"));
      } else if (key === "rotation") {
        body.appendChild(
          labeledRow("Rotation", numberInput("rotation", obj.angle || 0, 1), "°")
        );
      } else if (key === "fontSize") {
        body.appendChild(
          labeledRow("Font size", numberInput("fontSize", obj.fontSize || 16, 1), "px")
        );
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
        body.appendChild(labeledRow("Font", sel));
      } else if (key === "text") {
        var ta = el("textarea", {
          className: "editor-props-textarea",
          "data-prop": "text",
          rows: "3",
          maxlength: String(limits().textMax || 200),
        });
        ta.value = obj.text || "";
        body.appendChild(labeledRow("Text", ta));
      } else if (key === "keepProportions") {
        var chk = el("input", {
          type: "checkbox",
          className: "editor-props-check",
          "data-prop": "keepProportions",
        });
        chk.checked = keepProportions;
        var lab = el("label", { className: "editor-props-check-label" });
        lab.appendChild(chk);
        lab.appendChild(document.createTextNode(" Keep proportions"));
        body.appendChild(el("div", { className: "editor-props-row" }, [lab]));
      }
    });
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
      if (!panel || panel.hidden) {
        syncing = false;
        return;
      }
      // Rebuild when type/selection identity changes; otherwise patch values.
      var body = bodyEl();
      var marker = body && body.getAttribute("data-sync-for");
      var id = obj && (obj.blytzId || typeKey(obj) + ":" + (obj.text || ""));
      if (!body || marker !== String(id) || typeKey(obj) === "activeselection") {
        buildControls(obj);
        if (body && id != null) body.setAttribute("data-sync-for", String(id));
      } else {
        patchValues(obj);
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
      var input = body.querySelector('[data-prop="' + k + '"]');
      if (!input || document.activeElement === input) return;
      if (k === "opacity") {
        input.value = String(map[k]);
        var out = body.querySelector('[data-prop-out="opacity"]');
        if (out) out.textContent = map[k] + "%";
      } else if (map[k] != null && !isNaN(map[k])) {
        input.value = String(Math.round(map[k] * 1000) / 1000);
      }
    });
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
  }

  function parseNumber(raw) {
    if (raw === "" || raw == null) return NaN;
    return Number(raw);
  }

  function wirePanelEvents() {
    var panel = panelEl();
    if (!panel) return;

    panel.addEventListener("pointerdown", function (e) {
      var obj = activeObject();
      var target = e.target.closest("[data-prop]");
      if (!target || !obj) return;
      var key = target.getAttribute("data-prop");
      if (target.type === "range" || target.type === "color") {
        beginLive(obj, key);
      }
    });

    panel.addEventListener("input", function (e) {
      var obj = activeObject();
      if (!obj || syncing) return;
      var t = e.target;
      if (t.getAttribute("data-prop") === "keepProportions") {
        keepProportions = !!t.checked;
        return;
      }
      var key = t.getAttribute("data-prop");
      if (!key) return;
      if (key === "opacity" && t.type === "range") {
        var pct = parseNumber(t.value);
        var out = panel.querySelector('[data-prop-out="opacity"]');
        if (out) out.textContent = (isNaN(pct) ? 0 : pct) + "%";
        if (!isNaN(pct)) liveUpdate(obj, "opacity", pct / 100);
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
        var before = obj.text;
        var next = t.value;
        if (next === before) return;
        commitField(obj, "text", next);
        return;
      }
      if (t.type === "number") {
        var n = parseNumber(t.value);
        if (isNaN(n)) {
          scheduleSync();
          return;
        }
        // change may already have committed; only commit if different
        var snap = readSnapshot(obj);
        var probe = Object.assign({}, snap);
        // Compare against applying conceptually — if value already matches, skip
        if (key === "posX" && Math.abs(snap.cx - n) < 0.001) return;
        if (key === "posY" && Math.abs(snap.cy - n) < 0.001) return;
        if (key === "width" && Math.abs(snap.sw - n) < 0.001) return;
        if (key === "height" && Math.abs(snap.sh - n) < 0.001) return;
        if (key === "rotation" && Math.abs(normAngle(snap.angle) - normAngle(n)) < 0.001)
          return;
        if (key === "strokeWidth" && snap.strokeWidth === n) return;
        if (key === "fontSize" && snap.fontSize === n) return;
        commitField(obj, key, n);
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
    isSheetOpen: function () {
      return sheetOpen && panelEl() && !panelEl().hidden;
    },
  };

  document.addEventListener("DOMContentLoaded", init);
})(window);
