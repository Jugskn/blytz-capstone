/**
 * Stage 3b — shared editor tool panels (Upload, Elements) + shape/graphics factories.
 * Canvas mutations go through BlytzCanvas.commitEdit / insertElement / addImageFromFile.
 */
(function (global) {
  "use strict";

  var openPanelId = null;
  var lastTrigger = null;
  var wired = false;

  /** Local graphics: each is one Polygon or Path (never a Group). No SVG parsing. */
  var GRAPHICS_DEFS = {
    // 5-point star: alternating outer/inner radii around origin.
    star: {
      label: "Star",
      kind: "polygon",
      build: function (R) {
        var outer = R * 0.5;
        var inner = outer * 0.4;
        var pts = [];
        for (var i = 0; i < 10; i++) {
          var rad = i % 2 === 0 ? outer : inner;
          var a = -Math.PI / 2 + (i * Math.PI) / 5;
          pts.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad });
        }
        return pts;
      },
    },
    // Right arrow: shaft + head as one polygon.
    arrow: {
      label: "Arrow",
      kind: "polygon",
      build: function (R) {
        var w = R * 0.5;
        var h = R * 0.28;
        return [
          { x: -w, y: -h * 0.35 },
          { x: w * 0.15, y: -h * 0.35 },
          { x: w * 0.15, y: -h },
          { x: w, y: 0 },
          { x: w * 0.15, y: h },
          { x: w * 0.15, y: h * 0.35 },
          { x: -w, y: h * 0.35 },
        ];
      },
    },
    // Shield / badge silhouette.
    badge: {
      label: "Badge",
      kind: "polygon",
      build: function (R) {
        var w = R * 0.4;
        var h = R * 0.5;
        return [
          { x: -w, y: -h * 0.7 },
          { x: w, y: -h * 0.7 },
          { x: w, y: h * 0.15 },
          { x: 0, y: h },
          { x: -w, y: h * 0.15 },
        ];
      },
    },
    // Heart as a single Path (cubic beziers). Scale so max edge ≈ 190 at R=200.
    heart: {
      label: "Heart",
      kind: "path",
      build: function (R) {
        var s = R * 0.0175;
        return (
          "M " +
          0 +
          " " +
          12 * s +
          " C " +
          -20 * s +
          " " +
          -2 * s +
          ", " +
          -40 * s +
          " " +
          -28 * s +
          ", " +
          0 +
          " " +
          -42 * s +
          " C " +
          40 * s +
          " " +
          -28 * s +
          ", " +
          20 * s +
          " " +
          -2 * s +
          ", " +
          0 +
          " " +
          12 * s +
          " Z"
        );
      },
    },
    // Lightning bolt polygon (single closed outline).
    lightning: {
      label: "Lightning",
      kind: "polygon",
      build: function (R) {
        var s = R * 0.5;
        return [
          { x: 0.15 * s, y: -s },
          { x: -0.35 * s, y: -0.05 * s },
          { x: -0.05 * s, y: -0.05 * s },
          { x: -0.2 * s, y: s },
          { x: 0.4 * s, y: 0.05 * s },
          { x: 0.1 * s, y: 0.05 * s },
        ];
      },
    },
    // Starburst: 16-point spike star.
    starburst: {
      label: "Starburst",
      kind: "polygon",
      build: function (R) {
        var outer = R * 0.5;
        var inner = outer * 0.35;
        var spikes = 8;
        var pts = [];
        for (var i = 0; i < spikes * 2; i++) {
          var rad = i % 2 === 0 ? outer : inner;
          var a = -Math.PI / 2 + (i * Math.PI) / spikes;
          pts.push({ x: Math.cos(a) * rad, y: Math.sin(a) * rad });
        }
        return pts;
      },
    },
  };

  function api() {
    return global.BlytzCanvas;
  }

  function isMobilePanel() {
    return window.matchMedia && window.matchMedia("(max-width: 1023px)").matches;
  }

  function panelEl() {
    return document.getElementById("editor-tool-panel");
  }

  function panelBody() {
    return document.querySelector("[data-panel-body]");
  }

  function panelTitle() {
    return document.getElementById("editor-tool-panel-title");
  }

  function panelFeedback() {
    return document.querySelector("[data-panel-feedback]");
  }

  function setPanelFeedback(msg) {
    var el = panelFeedback();
    if (el) el.textContent = msg || "";
  }

  function toolbarBtn(action) {
    return document.querySelector(
      '#editor-toolbar [data-editor-action="' + action + '"]'
    );
  }

  function panelIdForAction(action) {
    if (action === "garment") return "garment";
    if (action === "add-image") return "upload";
    if (action === "elements") return "elements";
    if (action === "layers") return "layers";
    return null;
  }

  var GARMENT_VIEW_BLOCK_TITLE =
    "Choose an AI suggestion or edit the design first";

  var SVG_NS = "http://www.w3.org/2000/svg";

  function garmentsApi() {
    return global.BlytzGarments;
  }

  function garmentColorsForPanel() {
    var g = garmentsApi();
    if (!g || !g.GARMENT_COLORS) return [];
    var out = [];
    g.GARMENT_COLORS.forEach(function (c) {
      if (c.id === "grey") return;
      out.push(c);
    });
    return out;
  }

  function garmentSummaryLabel(state) {
    state = state || {};
    var g = garmentsApi();
    var template = state.template || "tee";
    var colorId = state.color || "white";
    var typeLabel = template;
    var colorLabel = colorId;
    if (g) {
      var gt = g.garmentById && g.garmentById(template);
      if (gt && gt.label) typeLabel = gt.label;
      var col = g.colorById && g.colorById(colorId);
      if (col && col.label) colorLabel = col.label;
    }
    return typeLabel + ", " + colorLabel;
  }

  function updateGarmentSummary() {
    var el = document.getElementById("editor-garment-summary");
    if (!el || !global.BlytzEditor || !global.BlytzEditor.getGarmentState) return;
    el.textContent = garmentSummaryLabel(global.BlytzEditor.getGarmentState());
  }

  function syncGarmentPanelLive(body) {
    if (!body) body = panelBody();
    if (!body) return;
    var live = body.querySelector("[data-garment-panel-live]");
    if (!live || !global.BlytzEditor || !global.BlytzEditor.getGarmentState) return;
    live.textContent = garmentSummaryLabel(global.BlytzEditor.getGarmentState());
  }

  function syncGarmentPanelPressed(body) {
    if (!body) body = panelBody();
    if (!body || !global.BlytzEditor || !global.BlytzEditor.getGarmentState) return;
    var state = global.BlytzEditor.getGarmentState();
    body.querySelectorAll("[data-garment-type]").forEach(function (btn) {
      var id = btn.getAttribute("data-garment-type");
      var on = id === state.template;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    body.querySelectorAll("[data-garment-color]").forEach(function (btn) {
      var id = btn.getAttribute("data-garment-color");
      var on = id === state.color;
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function viewSwitchBlocked() {
    var a = api();
    var canvasPending =
      a && typeof a.aiCandidatesPending === "function" && a.aiCandidatesPending();
    var chatPending =
      global.BlytzAIChat &&
      typeof global.BlytzAIChat.hasPendingCandidates === "function" &&
      global.BlytzAIChat.hasPendingCandidates();
    return !!(canvasPending || chatPending);
  }

  function refreshViewToggle() {
    // Toolbar toggle fallback (overlay overlapped #editor-canvas-wrap at standard VPs).
    var btn = document.getElementById("editor-view-toggle-btn");
    if (!btn) return;
    var active =
      global.BlytzEditor && global.BlytzEditor.getActiveView
        ? global.BlytzEditor.getActiveView()
        : "front";
    var blocked = viewSwitchBlocked();
    var label = active === "back" ? "Back" : "Front";
    var icon = btn.querySelector("[data-view-toggle-icon]");
    var text = btn.querySelector("[data-view-toggle-label]");
    if (icon) icon.textContent = active === "back" ? "B" : "F";
    if (text) text.textContent = label;
    btn.setAttribute("aria-label", "Garment view: " + label);
    btn.setAttribute("aria-pressed", "true");
    if (blocked) {
      btn.setAttribute("aria-disabled", "true");
      btn.title = GARMENT_VIEW_BLOCK_TITLE;
    } else {
      btn.removeAttribute("aria-disabled");
      btn.title = "Switch to " + (active === "back" ? "Front" : "Back") + " view";
    }
  }

  function svgTagForPartKind(kind) {
    if (kind === "path") return "path";
    if (kind === "polygon") return "polygon";
    if (kind === "rect") return "rect";
    if (kind === "circle") return "circle";
    if (kind === "line") return "line";
    return "path";
  }

  function applyThumbPartShape(el, def) {
    var kind = def.kind;
    if (kind === "path" && def.d) {
      el.setAttribute("d", def.d);
    } else if (kind === "polygon" && def.points) {
      el.setAttribute("points", def.points);
    } else if (kind === "rect") {
      if (def.x != null) el.setAttribute("x", String(def.x));
      if (def.y != null) el.setAttribute("y", String(def.y));
      if (def.w != null) el.setAttribute("width", String(def.w));
      if (def.h != null) el.setAttribute("height", String(def.h));
    } else if (kind === "circle") {
      if (def.x != null) el.setAttribute("cx", String(def.x));
      if (def.y != null) el.setAttribute("cy", String(def.y));
      if (def.r != null) el.setAttribute("r", String(def.r));
    } else if (kind === "line") {
      if (def.x1 != null) el.setAttribute("x1", String(def.x1));
      if (def.y1 != null) el.setAttribute("y1", String(def.y1));
      if (def.x2 != null) el.setAttribute("x2", String(def.x2));
      if (def.y2 != null) el.setAttribute("y2", String(def.y2));
    }
  }

  function styleThumbPart(el, def, fillHex, trimHex) {
    var role = def.role || "fill";
    if (role === "fill") {
      el.setAttribute("fill", fillHex);
      el.setAttribute("stroke", "none");
    } else if (role === "stroke") {
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", trimHex);
      el.setAttribute("stroke-width", "2");
    } else if (role === "outline") {
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "rgba(0,0,0,0.2)");
      el.setAttribute("stroke-width", "2");
    }
  }

  function buildGarmentTypeThumb(garmentId) {
    var g = garmentsApi();
    if (!g || typeof g.buildPartsForTest !== "function") return null;
    var parts = g.buildPartsForTest(garmentId, "front");
    var fillHex = "#d4d4d8";
    var trimHex =
      typeof g.shadeColor === "function" ? g.shadeColor(fillHex, -0.25) : "#a1a1aa";
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 800 800");
    svg.setAttribute("class", "editor-garment-thumb");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    for (var i = 0; i < parts.length; i++) {
      var def = parts[i];
      if (!def || !def.kind) continue;
      var node = document.createElementNS(SVG_NS, svgTagForPartKind(def.kind));
      applyThumbPartShape(node, def);
      styleThumbPart(node, def, fillHex, trimHex);
      svg.appendChild(node);
    }
    return svg;
  }

  function renderGarmentBody(body) {
    while (body.firstChild) body.removeChild(body.firstChild);
    var g = garmentsApi();
    if (!g) {
      var err = document.createElement("p");
      err.className = "editor-panel-lead";
      err.textContent = "Garment options are not available.";
      body.appendChild(err);
      return;
    }

    var heading = document.createElement("h3");
    heading.className = "editor-panel-h";
    heading.textContent = "Type";
    body.appendChild(heading);

    var types = document.createElement("div");
    types.className = "editor-garment-types";
    types.setAttribute("role", "group");
    types.setAttribute("aria-label", "Garment type");
    (g.GARMENT_TYPES || []).forEach(function (gt) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "editor-garment-type-btn";
      btn.setAttribute("data-garment-type", gt.id);
      btn.setAttribute("aria-pressed", "false");
      btn.setAttribute("aria-label", gt.label);
      var thumb = buildGarmentTypeThumb(gt.id);
      if (thumb) btn.appendChild(thumb);
      var lab = document.createElement("span");
      lab.textContent = gt.label;
      btn.appendChild(lab);
      types.appendChild(btn);
    });
    body.appendChild(types);

    var colorHeading = document.createElement("h3");
    colorHeading.className = "editor-panel-h";
    colorHeading.style.marginTop = "1rem";
    colorHeading.textContent = "Color";
    body.appendChild(colorHeading);

    var swatches = document.createElement("div");
    swatches.className = "editor-garment-swatches";
    swatches.setAttribute("role", "group");
    swatches.setAttribute("aria-label", "Garment color");
    garmentColorsForPanel().forEach(function (c) {
      var sw = document.createElement("button");
      sw.type = "button";
      sw.className = "editor-garment-swatch";
      sw.setAttribute("data-garment-color", c.id);
      sw.setAttribute("aria-pressed", "false");
      sw.setAttribute("aria-label", c.label);
      sw.style.backgroundColor = c.hex;
      swatches.appendChild(sw);
    });
    body.appendChild(swatches);

    var live = document.createElement("p");
    live.className = "editor-garment-live";
    live.setAttribute("data-garment-panel-live", "");
    live.setAttribute("aria-live", "polite");
    body.appendChild(live);

    syncGarmentPanelPressed(body);
    syncGarmentPanelLive(body);
  }

  function syncExpanded() {
    ["garment", "add-image", "elements", "layers"].forEach(function (action) {
      var btn = toolbarBtn(action);
      if (!btn) return;
      var expanded = openPanelId === panelIdForAction(action);
      btn.setAttribute("aria-expanded", expanded ? "true" : "false");
      btn.classList.toggle("is-active", expanded);
    });
  }

  function closePanel() {
    var panel = panelEl();
    if (!panel) return;
    panel.hidden = true;
    panel.classList.remove("is-open");
    openPanelId = null;
    syncExpanded();
    if (api()) api().setMessageSink(null);
    setPanelFeedback("");
    if (lastTrigger && typeof lastTrigger.focus === "function") {
      try {
        lastTrigger.focus();
      } catch (err) {
        /* ignore */
      }
    }
    lastTrigger = null;
  }

  function objectTypeKey(obj) {
    var a = api();
    if (a && typeof a.typeKey === "function") return a.typeKey(obj);
    return String((obj && obj.type) || "")
      .toLowerCase()
      .replace(/[^a-z]/g, "");
  }

  function typeGlyph(obj) {
    var t = objectTypeKey(obj);
    if (t === "itext" || t === "text" || t === "textbox") return "T";
    if (t === "image") return "▣";
    if (t === "line") return "／";
    if (t === "ellipse" || t === "circle") return "◯";
    if (t === "rect") return "▭";
    if (t === "path") return "∿";
    if (t === "polygon") return "◇";
    return "•";
  }

  function typeFallbackLabel(obj) {
    var t = objectTypeKey(obj);
    if (t === "itext" || t === "text" || t === "textbox") return "Text";
    if (t === "image") return "Image";
    if (t === "line") return "Line";
    if (t === "ellipse") return "Ellipse";
    if (t === "circle") return "Circle";
    if (t === "rect") return "Rectangle";
    if (t === "path") return "Path";
    if (t === "polygon") return "Polygon";
    return "Object";
  }

  /** Layer row label: text truncated; else blytzName; else type fallback. */
  function layerLabel(obj) {
    var t = objectTypeKey(obj);
    if (t === "itext" || t === "text" || t === "textbox") {
      var text = obj && typeof obj.text === "string" ? obj.text : "";
      if (text.length > 20) return text.slice(0, 20) + "…";
      return text || "Text";
    }
    if (obj && typeof obj.blytzName === "string" && obj.blytzName) {
      return obj.blytzName;
    }
    return typeFallbackLabel(obj);
  }

  function renderLayerRow(obj, selectedIds) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "editor-layer-row";
    btn.setAttribute("data-layer-id", obj.blytzId || "");
    var pressed = !!(obj.blytzId && selectedIds[obj.blytzId]);
    btn.setAttribute("aria-pressed", pressed ? "true" : "false");
    if (pressed) btn.classList.add("is-selected");

    var glyph = document.createElement("span");
    glyph.className = "editor-layer-glyph";
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = typeGlyph(obj);

    var lab = document.createElement("span");
    lab.className = "editor-layer-label";
    lab.textContent = layerLabel(obj);

    btn.appendChild(glyph);
    btn.appendChild(lab);
    btn.setAttribute("aria-label", "Select layer " + layerLabel(obj));
    return btn;
  }

  function selectedIdMap() {
    var map = Object.create(null);
    var c = api() && api().getFabricCanvas();
    if (!c) return map;
    var active = c.getActiveObjects ? c.getActiveObjects() : [];
    (active || []).forEach(function (o) {
      if (o && o.blytzId) map[o.blytzId] = true;
    });
    return map;
  }

  function getJSON() {
    return global.BlytzEditor && global.BlytzEditor.getCanvasJSON();
  }

  function renderLayersBody(body) {
    while (body.firstChild) body.removeChild(body.firstChild);

    var toolbar = document.createElement("div");
    toolbar.className = "editor-layers-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Layer order");

    function layerActionBtn(action, label) {
      var b = document.createElement("button");
      b.type = "button";
      b.className = "editor-layers-action";
      b.setAttribute("data-layer-action", action);
      b.setAttribute("aria-label", label);
      b.title = label;
      b.textContent = label;
      return b;
    }

    toolbar.appendChild(layerActionBtn("front", "Bring to Front"));
    toolbar.appendChild(layerActionBtn("forward", "Bring Forward"));
    toolbar.appendChild(layerActionBtn("backward", "Send Backward"));
    toolbar.appendChild(layerActionBtn("back", "Send to Back"));
    toolbar.appendChild(layerActionBtn("delete", "Delete"));
    body.appendChild(toolbar);

    var list = document.createElement("div");
    list.className = "editor-layers-list";
    list.setAttribute("data-layers-list", "");
    list.setAttribute("role", "list");
    body.appendChild(list);
    fillLayersList(list);
    syncLayerActionState(toolbar);
  }

  function fillLayersList(list) {
    if (!list) list = document.querySelector("[data-layers-list]");
    if (!list) return;
    var t0 =
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    while (list.firstChild) list.removeChild(list.firstChild);
    var c = api() && api().getFabricCanvas();
    var objects = c ? c.getObjects().slice() : [];
    // FRONTMOST at the TOP — reverse Fabric bottom→top order.
    objects.reverse();
    var selected = selectedIdMap();
    if (!objects.length) {
      var empty = document.createElement("p");
      empty.className = "editor-layers-empty";
      empty.textContent = "No layers yet.";
      list.appendChild(empty);
    } else {
      objects.forEach(function (obj) {
        var row = renderLayerRow(obj, selected);
        row.setAttribute("role", "listitem");
        list.appendChild(row);
      });
    }
    var t1 =
      typeof performance !== "undefined" && performance.now ? performance.now() : Date.now();
    list.setAttribute("data-render-ms", String(Math.round((t1 - t0) * 100) / 100));
  }

  function syncLayerActionState(toolbar) {
    toolbar = toolbar || document.querySelector(".editor-layers-toolbar");
    if (!toolbar || !api()) return;
    var c = api().getFabricCanvas();
    var active = c && c.getActiveObject();
    var multi = !!(active && api().isActiveSelection(active));
    ["forward", "backward", "front", "back"].forEach(function (action) {
      var btn = toolbar.querySelector('[data-layer-action="' + action + '"]');
      if (!btn) return;
      var can = !multi && api().canReorderActive(action);
      if (multi) {
        btn.setAttribute("aria-disabled", "true");
        btn.disabled = true;
        btn.title = "Reorder is unavailable for multi-selection";
      } else if (!can) {
        btn.setAttribute("aria-disabled", "true");
        btn.disabled = true;
        btn.title = "Already at the edge of the stack";
      } else {
        btn.removeAttribute("aria-disabled");
        btn.disabled = false;
        btn.title = btn.getAttribute("aria-label") || "";
      }
    });
    var del = toolbar.querySelector('[data-layer-action="delete"]');
    if (del) {
      var has = !!(active || (c && c.getActiveObjects && c.getActiveObjects().length));
      del.disabled = !has;
      del.setAttribute("aria-disabled", has ? "false" : "true");
    }
  }

  var layersRaf = 0;
  function refreshLayers() {
    if (openPanelId !== "layers") {
      // Still cheap to skip full render when closed.
      return;
    }
    if (layersRaf) return;
    layersRaf = requestAnimationFrame(function () {
      layersRaf = 0;
      fillLayersList();
      syncLayerActionState();
    });
  }

  function formatInputLimitLabel() {
    var a = api();
    var bytes = a && a.IMAGE_INPUT_LIMIT_BYTES != null ? a.IMAGE_INPUT_LIMIT_BYTES : 8 * 1024 * 1024;
    var target = a && a.IMAGE_TARGET_BYTES != null ? a.IMAGE_TARGET_BYTES : 300 * 1024;
    return {
      inputMb: Math.round(bytes / (1024 * 1024)),
      targetKb: Math.round(target / 1024),
    };
  }

  function renderUploadBody(body) {
    var lim = formatInputLimitLabel();
    body.innerHTML =
      '<p class="editor-panel-lead">Add an image to the canvas. Files are embedded in the design.</p>' +
      '<p class="editor-panel-meta">Accepted: PNG, JPEG, WebP · up to ' +
      lim.inputMb +
      " MB input · stored around " +
      lim.targetKb +
      " KB</p>" +
      '<button type="button" class="editor-panel-primary" data-panel-choose-image>' +
      "Choose image</button>";
  }

  function shapeButton(id, label, mark) {
    return (
      '<button type="button" class="editor-panel-tile" data-insert-shape="' +
      id +
      '" aria-label="' +
      label +
      '">' +
      '<span class="editor-panel-tile-mark" aria-hidden="true">' +
      mark +
      "</span>" +
      '<span class="editor-panel-tile-label">' +
      label +
      "</span></button>"
    );
  }

  function renderElementsBody(body) {
    var html = '<section class="editor-panel-section"><h3 class="editor-panel-h">Basic shapes</h3>';
    html += '<div class="editor-panel-grid">';
    html += shapeButton("rect", "Rectangle", "▭");
    html += shapeButton("ellipse", "Ellipse", "◯");
    html += shapeButton("line", "Line", "／");
    html += "</div></section>";
    html += '<section class="editor-panel-section"><h3 class="editor-panel-h">Graphics</h3>';
    html += '<div class="editor-panel-grid">';
    Object.keys(GRAPHICS_DEFS).forEach(function (key) {
      var def = GRAPHICS_DEFS[key];
      var mark =
        key === "star"
          ? "★"
          : key === "arrow"
            ? "→"
            : key === "badge"
              ? "⛨"
              : key === "heart"
                ? "♥"
                : key === "lightning"
                  ? "⚡"
                  : "✸";
      html += shapeButton(key, def.label, mark);
    });
    html += "</div></section>";
    body.innerHTML = html;
  }

  function openPanel(id, trigger) {
    var panel = panelEl();
    var body = panelBody();
    var title = panelTitle();
    if (!panel || !body || !title) return;
    if (
      global.BlytzEditorProps &&
      typeof global.BlytzEditorProps.onToolPanelOpening === "function"
    ) {
      global.BlytzEditorProps.onToolPanelOpening();
    }
    lastTrigger = trigger || lastTrigger;
    openPanelId = id;
    title.textContent =
      id === "upload"
        ? "Upload image"
        : id === "layers"
          ? "Layers"
          : id === "garment"
            ? "Garment"
            : "Elements";
    panel.setAttribute("aria-labelledby", "editor-tool-panel-title");
    if (id === "upload") renderUploadBody(body);
    else if (id === "layers") renderLayersBody(body);
    else if (id === "garment") renderGarmentBody(body);
    else renderElementsBody(body);
    panel.hidden = false;
    panel.classList.add("is-open");
    syncExpanded();
    setPanelFeedback("");
    if (api()) {
      api().setMessageSink(function (msg) {
        setPanelFeedback(msg);
      });
    }
    var closeBtn = panel.querySelector("[data-panel-close]");
    if (closeBtn) closeBtn.focus();
  }

  function togglePanel(id, trigger) {
    if (openPanelId === id) {
      closePanel();
      return;
    }
    openPanel(id, trigger);
  }

  var SHAPE_LAYER_NAMES = {
    rect: "Rectangle",
    ellipse: "Ellipse",
    line: "Line",
    star: "Star",
    arrow: "Arrow",
    badge: "Badge",
    heart: "Heart",
    lightning: "Lightning",
    starburst: "Starburst",
  };

  function fabricObjectFromShape(shapeId, pos) {
    var fabric = global.fabric;
    var a = api();
    if (!fabric || !a) return null;
    var fill =
      typeof a.defaultContrastFill === "function"
        ? a.defaultContrastFill()
        : a.DEFAULT_SHAPE_FILL;
    var R = a.DEFAULT_SHAPE_MAX_EDGE;
    var common = {
      left: pos.left,
      top: pos.top,
      originX: "center",
      originY: "center",
      strokeUniform: true,
    };
    var layerName = SHAPE_LAYER_NAMES[shapeId] || "Shape";
    var obj = null;

    if (shapeId === "rect") {
      obj = new fabric.Rect(
        Object.assign({}, common, {
          width: R * 0.85,
          height: R * 0.65,
          fill: fill,
          strokeWidth: 0,
        })
      );
    } else if (shapeId === "ellipse") {
      obj = new fabric.Ellipse(
        Object.assign({}, common, {
          rx: R * 0.42,
          ry: R * 0.32,
          fill: fill,
          strokeWidth: 0,
        })
      );
    } else if (shapeId === "line") {
      var half = R * 0.45;
      obj = new fabric.Line([-half, 0, half, 0], {
        left: pos.left,
        top: pos.top,
        originX: "center",
        originY: "center",
        stroke: fill,
        strokeWidth: 6,
        fill: "",
        strokeUniform: true,
      });
    } else {
      var def = GRAPHICS_DEFS[shapeId];
      if (!def) return null;
      var geom = def.build(R);
      if (def.kind === "path") {
        obj = new fabric.Path(geom, Object.assign({}, common, { fill: fill, strokeWidth: 0 }));
      } else {
        obj = new fabric.Polygon(
          geom,
          Object.assign({}, common, { fill: fill, strokeWidth: 0 })
        );
      }
    }
    if (obj && a.assignBlytzName) a.assignBlytzName(obj, layerName);
    else if (obj) obj.blytzName = layerName;
    return obj;
  }

  function insertShape(shapeId) {
    var a = api();
    if (!a || !global.BlytzEditor) return;
    var getJSON = function () {
      return global.BlytzEditor.getCanvasJSON();
    };
    var ok = a.insertElement(
      "insert-" + shapeId,
      function (pos) {
        return fabricObjectFromShape(shapeId, pos);
      },
      getJSON,
      SHAPE_LAYER_NAMES[shapeId]
    );
    if (ok) {
      setPanelFeedback("Added " + (GRAPHICS_DEFS[shapeId] ? GRAPHICS_DEFS[shapeId].label : shapeId) + ".");
      onSuccessfulInsert("elements");
    }
  }

  function onSuccessfulInsert(fromPanel) {
    if (isMobilePanel() && openPanelId) {
      closePanel();
    }
  }

  function wire() {
    if (wired) return;
    wired = true;

    document.addEventListener("click", function (e) {
      var choose = e.target.closest("[data-panel-choose-image]");
      if (choose) {
        e.preventDefault();
        if (api()) api().triggerImagePicker();
        return;
      }
      var shapeBtn = e.target.closest("[data-insert-shape]");
      if (shapeBtn) {
        e.preventDefault();
        insertShape(shapeBtn.getAttribute("data-insert-shape"));
        return;
      }
      var close = e.target.closest("[data-panel-close]");
      if (close && panelEl() && panelEl().contains(close)) {
        e.preventDefault();
        closePanel();
        return;
      }
      var viewToggleBtn = e.target.closest(
        '[data-editor-action="toggle-view"], #editor-view-toggle-btn'
      );
      if (viewToggleBtn) {
        e.preventDefault();
        if (viewToggleBtn.getAttribute("aria-disabled") === "true") return;
        if (!global.BlytzEditor || !global.BlytzEditor.setActiveView) return;
        var cur =
          typeof global.BlytzEditor.getActiveView === "function"
            ? global.BlytzEditor.getActiveView()
            : "front";
        var next = cur === "back" ? "front" : "back";
        global.BlytzEditor.setActiveView(next).then(function () {
          refreshViewToggle();
        });
        return;
      }
      var garmentType = e.target.closest("[data-garment-type]");
      if (garmentType && panelEl() && panelEl().contains(garmentType)) {
        e.preventDefault();
        if (!global.BlytzEditor || !global.BlytzEditor.setGarmentState) return;
        global.BlytzEditor.setGarmentState({
          template: garmentType.getAttribute("data-garment-type"),
        });
        syncGarmentPanelPressed();
        syncGarmentPanelLive();
        updateGarmentSummary();
        return;
      }
      var garmentColor = e.target.closest("[data-garment-color]");
      if (garmentColor && panelEl() && panelEl().contains(garmentColor)) {
        e.preventDefault();
        if (!global.BlytzEditor || !global.BlytzEditor.setGarmentState) return;
        global.BlytzEditor.setGarmentState({
          color: garmentColor.getAttribute("data-garment-color"),
        });
        syncGarmentPanelPressed();
        syncGarmentPanelLive();
        updateGarmentSummary();
        return;
      }
      var actionBtn = e.target.closest("#editor-toolbar [data-editor-action]");
      if (!actionBtn || actionBtn.disabled || actionBtn.getAttribute("aria-disabled") === "true") {
        return;
      }
      var action = actionBtn.getAttribute("data-editor-action");
      if (action === "garment") {
        e.preventDefault();
        e.stopPropagation();
        togglePanel("garment", actionBtn);
      } else if (action === "add-image") {
        e.preventDefault();
        e.stopPropagation();
        togglePanel("upload", actionBtn);
      } else if (action === "elements") {
        e.preventDefault();
        e.stopPropagation();
        togglePanel("elements", actionBtn);
      } else if (action === "layers") {
        e.preventDefault();
        e.stopPropagation();
        togglePanel("layers", actionBtn);
      }
    }, true);

    document.addEventListener("click", function (e) {
      var row = e.target.closest("[data-layer-id]");
      if (row && panelEl() && panelEl().contains(row)) {
        e.preventDefault();
        var id = row.getAttribute("data-layer-id");
        var c = api() && api().getFabricCanvas();
        if (!c || !id) return;
        var obj = null;
        var objs = c.getObjects();
        for (var i = 0; i < objs.length; i++) {
          if (objs[i].blytzId === id) {
            obj = objs[i];
            break;
          }
        }
        if (!obj) return;
        c.setActiveObject(obj);
        c.requestRenderAll();
        // Selection only — 0 commits.
        refreshLayers();
        if (global.BlytzEditorProps && BlytzEditorProps.syncFromSelection) {
          BlytzEditorProps.syncFromSelection();
        }
        return;
      }
      var actionBtn = e.target.closest("[data-layer-action]");
      if (actionBtn && panelEl() && panelEl().contains(actionBtn)) {
        e.preventDefault();
        if (actionBtn.disabled || actionBtn.getAttribute("aria-disabled") === "true") {
          return;
        }
        var act = actionBtn.getAttribute("data-layer-action");
        var a = api();
        if (!a) return;
        if (act === "delete") {
          a.deleteSelection(getJSON);
        } else {
          a.reorderActive(act, getJSON);
        }
        refreshLayers();
      }
    });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      if (!openPanelId) return;
      e.preventDefault();
      closePanel();
    });

    // Refresh layers on canvas structural / selection changes.
    var tries = 0;
    (function waitCanvas() {
      var c = api() && api().getFabricCanvas();
      if (!c) {
        if (tries++ < 40) setTimeout(waitCanvas, 50);
        return;
      }
      [
        "object:added",
        "object:removed",
        "selection:created",
        "selection:updated",
        "selection:cleared",
      ].forEach(function (ev) {
        c.on(ev, refreshLayers);
      });
      if (global.BlytzEditor && BlytzEditor.onCommittedChange) {
        BlytzEditor.onCommittedChange(refreshLayers);
      }
    })();

    function bindGarmentUi() {
      if (!global.BlytzEditor) return false;
      function refreshGarmentChrome() {
        updateGarmentSummary();
        refreshViewToggle();
      }
      if (typeof global.BlytzEditor.whenReady === "function") {
        global.BlytzEditor.whenReady().then(refreshGarmentChrome).catch(refreshGarmentChrome);
      } else {
        refreshGarmentChrome();
      }
      if (typeof global.BlytzEditor.onViewChange === "function") {
        global.BlytzEditor.onViewChange(function () {
          refreshViewToggle();
        });
      }
      if (typeof global.BlytzEditor.onGarmentChange === "function") {
        global.BlytzEditor.onGarmentChange(function () {
          updateGarmentSummary();
          if (openPanelId === "garment") {
            syncGarmentPanelPressed();
            syncGarmentPanelLive();
          }
        });
      }
      if (typeof global.BlytzEditor.onCommittedChange === "function") {
        global.BlytzEditor.onCommittedChange(function () {
          refreshViewToggle();
        });
      }
      return true;
    }
    var garmentTries = 0;
    (function waitEditorGarment() {
      if (bindGarmentUi()) return;
      if (garmentTries++ < 80) setTimeout(waitEditorGarment, 50);
    })();
  }

  var BlytzEditorTools = {
    GRAPHICS_DEFS: GRAPHICS_DEFS,
    SHAPE_LAYER_NAMES: SHAPE_LAYER_NAMES,
    openPanel: openPanel,
    closePanel: closePanel,
    onSuccessfulInsert: onSuccessfulInsert,
    fabricObjectFromShape: fabricObjectFromShape,
    refreshLayers: refreshLayers,
    layerLabel: layerLabel,
    renderLayerRow: renderLayerRow,
    getOpenPanelId: function () {
      return openPanelId;
    },
  };

  global.BlytzEditorTools = BlytzEditorTools;

  document.addEventListener("DOMContentLoaded", function () {
    wire();
    ["garment", "add-image", "elements", "layers"].forEach(function (action) {
      var btn = toolbarBtn(action);
      if (!btn) return;
      btn.setAttribute("aria-controls", "editor-tool-panel");
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-haspopup", "dialog");
    });
  });
})(window);
