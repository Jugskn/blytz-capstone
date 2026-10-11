/**
 * Blytz Capstone — Stage 3d/3e garment silhouettes + print-area overlay.
 * Vanilla JS; attaches global BlytzGarments (no modules).
 */
(function (global) {
  "use strict";

  var SVG_NS = "http://www.w3.org/2000/svg";
  var VIEW_BOX = "0 0 800 800";

  var VIEW_IDS = ["front", "back"];
  var DEFAULT_VIEW = "front";

  /* PLACEHOLDER — garment palette (ids match persisted Design.garment_color):
   * white #ffffff, black #111111, gray #6b7280, navy #1e3a8a, red #dc2626,
   * royal #2563eb, green #16a34a, yellow #facc15, orange #f97316, maroon #7f1d1d
   */
  var GARMENT_COLORS = [
    { id: "white", label: "White", hex: "#ffffff" },
    { id: "black", label: "Black", hex: "#111111" },
    { id: "gray", label: "Gray", hex: "#6b7280" },
    { id: "grey", label: "Gray", hex: "#6b7280" },
    { id: "navy", label: "Navy", hex: "#1e3a8a" },
    { id: "red", label: "Red", hex: "#dc2626" },
    { id: "royal", label: "Royal", hex: "#2563eb" },
    { id: "green", label: "Green", hex: "#16a34a" },
    { id: "yellow", label: "Yellow", hex: "#facc15" },
    { id: "orange", label: "Orange", hex: "#f97316" },
    { id: "maroon", label: "Maroon", hex: "#7f1d1d" },
  ];

  var COLOR_BY_HEX = Object.create(null);
  var COLOR_BY_ID = Object.create(null);
  (function indexColors() {
    for (var i = 0; i < GARMENT_COLORS.length; i++) {
      var c = GARMENT_COLORS[i];
      COLOR_BY_ID[c.id] = c;
      COLOR_BY_HEX[c.hex.toLowerCase()] = c;
    }
  })();

  /**
   * sRGB relative luminance (WCAG):
   * For each channel c_srgb in 0..1: c = c_srgb <= 0.03928 ? c_srgb/12.92 : ((c_srgb+0.055)/1.055)^2.4
   * L = 0.2126*R + 0.7152*G + 0.0722*B
   * contrastColor returns "#111111" when L > 0.5 else "#ffffff".
   */
  function contrastColor(hex) {
    var rgb = parseHex(hex);
    if (!rgb) return "#111111";
    var lin = [rgb.r, rgb.g, rgb.b].map(function (c) {
      c = c / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
    return L > 0.5 ? "#111111" : "#ffffff";
  }

  function parseHex(hex) {
    if (!hex || typeof hex !== "string") return null;
    var s = hex.trim();
    if (s.charAt(0) === "#") s = s.slice(1);
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
    };
  }

  function toHex(r, g, b) {
    function clamp(v) {
      return Math.max(0, Math.min(255, Math.round(v)));
    }
    function h(n) {
      var x = clamp(n).toString(16);
      return x.length === 1 ? "0" + x : x;
    }
    return "#" + h(r) + h(g) + h(b);
  }

  /** Darken (amount < 0) or lighten (amount > 0) a hex color for trim strokes. */
  function shadeColor(hex, amount) {
    var rgb = parseHex(hex);
    if (!rgb) return "#000000";
    var a = typeof amount === "number" ? amount : 0;
    if (a >= 0) {
      return toHex(
        rgb.r + (255 - rgb.r) * a,
        rgb.g + (255 - rgb.g) * a,
        rgb.b + (255 - rgb.b) * a
      );
    }
    var f = 1 + a;
    return toHex(rgb.r * f, rgb.g * f, rgb.b * f);
  }

  function colorById(id) {
    if (id == null || id === "") {
      return COLOR_BY_ID.white || GARMENT_COLORS[0];
    }
    var raw = String(id).trim();
    var lower = raw.toLowerCase();
    if (COLOR_BY_ID[lower]) return COLOR_BY_ID[lower];
    var hex = raw.charAt(0) === "#" ? raw : lower.charAt(0) === "#" ? lower : null;
    if (!hex && /^[0-9a-f]{6}$/i.test(raw)) hex = "#" + raw;
    if (!hex && /^[0-9a-f]{6}$/i.test(lower)) hex = "#" + lower;
    if (hex) {
      var hit = COLOR_BY_HEX[hex.toLowerCase()];
      if (hit) return hit;
      return { id: lower.replace(/^#/, "") || "custom", label: hex, hex: hex.toLowerCase() };
    }
    return COLOR_BY_ID.white || GARMENT_COLORS[0];
  }

  function mirrorX(x) {
    return 800 - x;
  }

  function mirrorPoints(points) {
    var out = [];
    for (var i = 0; i < points.length; i++) {
      out.push(mirrorX(points[i][0]), points[i][1]);
    }
    return out.join(" ");
  }

  function part(id, kind, role, attrs) {
    var p = { id: id, kind: kind, role: role };
    var k;
    for (k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) p[k] = attrs[k];
    }
    return p;
  }

  function teeFrontParts() {
    return [
      part("tee-front-l-sleeve", "polygon", "fill", {
        points: "60,175 175,125 215,195 195,295 85,320 55,250",
      }),
      part("tee-front-r-sleeve", "polygon", "fill", {
        points: mirrorPoints([
          [60, 175],
          [175, 125],
          [215, 195],
          [195, 295],
          [85, 320],
          [55, 250],
        ]),
      }),
      part("tee-front-body", "path", "fill", {
        d:
          "M 230 145 C 290 105 350 95 400 98 C 450 95 510 105 570 145 " +
          "L 555 715 C 545 748 255 748 245 715 Z",
      }),
      part("tee-front-neck", "path", "stroke", {
        d: "M 310 118 C 350 102 450 102 490 118",
      }),
      part("tee-front-l-cuff", "line", "stroke", { x1: 55, y1: 250, x2: 85, y2: 320 }),
      part("tee-front-r-cuff", "line", "stroke", {
        x1: mirrorX(55),
        y1: 250,
        x2: mirrorX(85),
        y2: 320,
      }),
      part("tee-front-hem", "line", "stroke", { x1: 255, y1: 735, x2: 545, y2: 735 }),
      part("tee-front-body-outline", "path", "outline", {
        d:
          "M 230 145 C 290 105 350 95 400 98 C 450 95 510 105 570 145 " +
          "L 555 715 C 545 748 255 748 245 715 Z",
      }),
      part("tee-front-l-sleeve-outline", "polygon", "outline", {
        points: "60,175 175,125 215,195 195,295 85,320 55,250",
      }),
      part("tee-front-r-sleeve-outline", "polygon", "outline", {
        points: mirrorPoints([
          [60, 175],
          [175, 125],
          [215, 195],
          [195, 295],
          [85, 320],
          [55, 250],
        ]),
      }),
    ];
  }

  function teeBackParts() {
    return [
      part("tee-back-l-sleeve", "polygon", "fill", {
        points: "62,178 178,128 212,198 188,298 88,318 58,252",
      }),
      part("tee-back-r-sleeve", "polygon", "fill", {
        points: mirrorPoints([
          [62, 178],
          [178, 128],
          [212, 198],
          [188, 298],
          [88, 318],
          [58, 252],
        ]),
      }),
      part("tee-back-body", "path", "fill", {
        d:
          "M 235 140 C 295 100 355 92 400 94 C 445 92 505 100 565 140 " +
          "L 558 718 C 548 752 252 752 242 718 Z",
      }),
      part("tee-back-yoke", "path", "stroke", {
        d: "M 265 155 C 320 135 480 135 535 155",
      }),
      part("tee-back-l-cuff", "line", "stroke", { x1: 58, y1: 252, x2: 88, y2: 318 }),
      part("tee-back-r-cuff", "line", "stroke", {
        x1: mirrorX(58),
        y1: 252,
        x2: mirrorX(88),
        y2: 318,
      }),
      part("tee-back-hem", "line", "stroke", { x1: 258, y1: 738, x2: 542, y2: 738 }),
      part("tee-back-body-outline", "path", "outline", {
        d:
          "M 235 140 C 295 100 355 92 400 94 C 445 92 505 100 565 140 " +
          "L 558 718 C 548 752 252 752 242 718 Z",
      }),
      part("tee-back-l-sleeve-outline", "polygon", "outline", {
        points: "62,178 178,128 212,198 188,298 88,318 58,252",
      }),
      part("tee-back-r-sleeve-outline", "polygon", "outline", {
        points: mirrorPoints([
          [62, 178],
          [178, 128],
          [212, 198],
          [188, 298],
          [88, 318],
          [58, 252],
        ]),
      }),
    ];
  }

  function poloFrontParts() {
    return [
      part("polo-front-l-sleeve", "polygon", "fill", {
        points: "68,190 185,145 218,210 205,285 95,305 65,245",
      }),
      part("polo-front-r-sleeve", "polygon", "fill", {
        points: mirrorPoints([
          [68, 190],
          [185, 145],
          [218, 210],
          [205, 285],
          [95, 305],
          [65, 245],
        ]),
      }),
      part("polo-front-body", "path", "fill", {
        d:
          "M 245 150 C 300 115 350 108 400 110 C 450 108 500 115 555 150 " +
          "L 545 710 C 535 742 265 742 255 710 Z",
      }),
      part("polo-front-collar-l", "path", "stroke", {
        d: "M 400 112 C 370 112 340 125 325 145 L 400 175 Z",
      }),
      part("polo-front-collar-r", "path", "stroke", {
        d: "M 400 112 C 430 112 460 125 475 145 L 400 175 Z",
      }),
      part("polo-front-placket", "line", "stroke", { x1: 400, y1: 175, x2: 400, y2: 420 }),
      part("polo-front-l-cuff", "line", "stroke", { x1: 65, y1: 245, x2: 95, y2: 305 }),
      part("polo-front-r-cuff", "line", "stroke", {
        x1: mirrorX(65),
        y1: 245,
        x2: mirrorX(95),
        y2: 305,
      }),
      part("polo-front-body-outline", "path", "outline", {
        d:
          "M 245 150 C 300 115 350 108 400 110 C 450 108 500 115 555 150 " +
          "L 545 710 C 535 742 265 742 255 710 Z",
      }),
      part("polo-front-l-sleeve-outline", "polygon", "outline", {
        points: "68,190 185,145 218,210 205,285 95,305 65,245",
      }),
      part("polo-front-r-sleeve-outline", "polygon", "outline", {
        points: mirrorPoints([
          [68, 190],
          [185, 145],
          [218, 210],
          [205, 285],
          [95, 305],
          [65, 245],
        ]),
      }),
    ];
  }

  function poloBackParts() {
    return [
      part("polo-back-l-sleeve", "polygon", "fill", {
        points: "70,192 188,148 220,212 202,288 98,308 68,248",
      }),
      part("polo-back-r-sleeve", "polygon", "fill", {
        points: mirrorPoints([
          [70, 192],
          [188, 148],
          [220, 212],
          [202, 288],
          [98, 308],
          [68, 248],
        ]),
      }),
      part("polo-back-body", "path", "fill", {
        d:
          "M 248 148 C 302 118 352 112 400 114 C 448 112 498 118 552 148 " +
          "L 542 712 C 532 744 268 744 258 712 Z",
      }),
      part("polo-back-collar", "path", "stroke", {
        d: "M 330 135 C 360 122 440 122 470 135",
      }),
      part("polo-back-l-cuff", "line", "stroke", { x1: 68, y1: 248, x2: 98, y2: 308 }),
      part("polo-back-r-cuff", "line", "stroke", {
        x1: mirrorX(68),
        y1: 248,
        x2: mirrorX(98),
        y2: 308,
      }),
      part("polo-back-hem", "line", "stroke", { x1: 268, y1: 736, x2: 532, y2: 736 }),
      part("polo-back-body-outline", "path", "outline", {
        d:
          "M 248 148 C 302 118 352 112 400 114 C 448 112 498 118 552 148 " +
          "L 542 712 C 532 744 268 744 258 712 Z",
      }),
      part("polo-back-l-sleeve-outline", "polygon", "outline", {
        points: "70,192 188,148 220,212 202,288 98,308 68,248",
      }),
      part("polo-back-r-sleeve-outline", "polygon", "outline", {
        points: mirrorPoints([
          [70, 192],
          [188, 148],
          [220, 212],
          [202, 288],
          [98, 308],
          [68, 248],
        ]),
      }),
    ];
  }

  function jerseyFrontParts() {
    return [
      part("jersey-front-l-sleeve", "polygon", "fill", {
        points: "55,165 170,118 210,188 200,310 80,335 50,255",
      }),
      part("jersey-front-r-sleeve", "polygon", "fill", {
        points: mirrorPoints([
          [55, 165],
          [170, 118],
          [210, 188],
          [200, 310],
          [80, 335],
          [50, 255],
        ]),
      }),
      part("jersey-front-body", "path", "fill", {
        d:
          "M 225 138 C 285 98 345 88 400 90 C 455 88 515 98 575 138 " +
          "L 562 722 C 552 756 248 756 238 722 Z",
      }),
      part("jersey-front-stripe-l", "line", "stroke", { x1: 268, y1: 200, x2: 268, y2: 700 }),
      part("jersey-front-stripe-r", "line", "stroke", { x1: 532, y1: 200, x2: 532, y2: 700 }),
      part("jersey-front-neck", "path", "stroke", {
        d: "M 350 115 L 400 145 L 450 115",
      }),
      part("jersey-front-l-cuff", "line", "stroke", { x1: 50, y1: 255, x2: 80, y2: 335 }),
      part("jersey-front-r-cuff", "line", "stroke", {
        x1: mirrorX(50),
        y1: 255,
        x2: mirrorX(80),
        y2: 335,
      }),
      part("jersey-front-body-outline", "path", "outline", {
        d:
          "M 225 138 C 285 98 345 88 400 90 C 455 88 515 98 575 138 " +
          "L 562 722 C 552 756 248 756 238 722 Z",
      }),
      part("jersey-front-l-sleeve-outline", "polygon", "outline", {
        points: "55,165 170,118 210,188 200,310 80,335 50,255",
      }),
      part("jersey-front-r-sleeve-outline", "polygon", "outline", {
        points: mirrorPoints([
          [55, 165],
          [170, 118],
          [210, 188],
          [200, 310],
          [80, 335],
          [50, 255],
        ]),
      }),
    ];
  }

  function jerseyBackParts() {
    return [
      part("jersey-back-l-sleeve", "polygon", "fill", {
        points: "58,168 172,122 208,192 198,312 82,332 52,258",
      }),
      part("jersey-back-r-sleeve", "polygon", "fill", {
        points: mirrorPoints([
          [58, 168],
          [172, 122],
          [208, 192],
          [198, 312],
          [82, 332],
          [52, 258],
        ]),
      }),
      part("jersey-back-body", "path", "fill", {
        d:
          "M 228 135 C 288 95 348 86 400 88 C 452 86 512 95 572 135 " +
          "L 560 725 C 550 758 250 758 240 725 Z",
      }),
      part("jersey-back-name", "rect", "stroke", { x: 300, y: 220, w: 200, h: 48 }),
      part("jersey-back-number", "rect", "stroke", { x: 340, y: 320, w: 120, h: 160 }),
      part("jersey-back-l-cuff", "line", "stroke", { x1: 52, y1: 258, x2: 82, y2: 332 }),
      part("jersey-back-r-cuff", "line", "stroke", {
        x1: mirrorX(52),
        y1: 258,
        x2: mirrorX(82),
        y2: 332,
      }),
      part("jersey-back-body-outline", "path", "outline", {
        d:
          "M 228 135 C 288 95 348 86 400 88 C 452 86 512 95 572 135 " +
          "L 560 725 C 550 758 250 758 240 725 Z",
      }),
      part("jersey-back-l-sleeve-outline", "polygon", "outline", {
        points: "58,168 172,122 208,192 198,312 82,332 52,258",
      }),
      part("jersey-back-r-sleeve-outline", "polygon", "outline", {
        points: mirrorPoints([
          [58, 168],
          [172, 122],
          [208, 192],
          [198, 312],
          [82, 332],
          [52, 258],
        ]),
      }),
    ];
  }

  function hoodieFrontParts() {
    return [
      part("hoodie-front-l-sleeve", "polygon", "fill", {
        points: "62,200 178,155 218,225 208,340 92,360 58,280",
      }),
      part("hoodie-front-r-sleeve", "polygon", "fill", {
        points: mirrorPoints([
          [62, 200],
          [178, 155],
          [218, 225],
          [208, 340],
          [92, 360],
          [58, 280],
        ]),
      }),
      part("hoodie-front-body", "path", "fill", {
        d:
          "M 240 165 C 295 130 350 122 400 124 C 450 122 505 130 560 165 " +
          "L 548 730 C 538 758 262 758 252 730 Z",
      }),
      part("hoodie-front-hood", "path", "fill", {
        d:
          "M 280 165 C 300 55 500 55 520 165 C 480 145 320 145 280 165 Z",
      }),
      part("hoodie-front-pocket", "path", "stroke", {
        d: "M 310 520 C 310 480 490 480 490 520 L 490 590 C 490 610 310 610 310 590 Z",
      }),
      part("hoodie-front-drawcord", "line", "stroke", { x1: 360, y1: 175, x2: 440, y2: 175 }),
      part("hoodie-front-l-cuff", "line", "stroke", { x1: 58, y1: 280, x2: 92, y2: 360 }),
      part("hoodie-front-r-cuff", "line", "stroke", {
        x1: mirrorX(58),
        y1: 280,
        x2: mirrorX(92),
        y2: 360,
      }),
      part("hoodie-front-body-outline", "path", "outline", {
        d:
          "M 240 165 C 295 130 350 122 400 124 C 450 122 505 130 560 165 " +
          "L 548 730 C 538 758 262 758 252 730 Z",
      }),
      part("hoodie-front-hood-outline", "path", "outline", {
        d:
          "M 280 165 C 300 55 500 55 520 165 C 480 145 320 145 280 165 Z",
      }),
      part("hoodie-front-l-sleeve-outline", "polygon", "outline", {
        points: "62,200 178,155 218,225 208,340 92,360 58,280",
      }),
      part("hoodie-front-r-sleeve-outline", "polygon", "outline", {
        points: mirrorPoints([
          [62, 200],
          [178, 155],
          [218, 225],
          [208, 340],
          [92, 360],
          [58, 280],
        ]),
      }),
    ];
  }

  function hoodieBackParts() {
    return [
      part("hoodie-back-l-sleeve", "polygon", "fill", {
        points: "64,202 180,158 220,228 210,342 94,362 60,282",
      }),
      part("hoodie-back-r-sleeve", "polygon", "fill", {
        points: mirrorPoints([
          [64, 202],
          [180, 158],
          [220, 228],
          [210, 342],
          [94, 362],
          [60, 282],
        ]),
      }),
      part("hoodie-back-body", "path", "fill", {
        d:
          "M 242 162 C 298 128 352 120 400 122 C 448 120 502 128 558 162 " +
          "L 546 732 C 536 760 264 760 254 732 Z",
      }),
      part("hoodie-back-hood", "path", "fill", {
        d:
          "M 265 162 C 285 48 515 48 535 162 C 490 138 310 138 265 162 Z",
      }),
      part("hoodie-back-seam", "line", "stroke", { x1: 400, y1: 162, x2: 400, y2: 720 }),
      part("hoodie-back-l-cuff", "line", "stroke", { x1: 60, y1: 282, x2: 94, y2: 362 }),
      part("hoodie-back-r-cuff", "line", "stroke", {
        x1: mirrorX(60),
        y1: 282,
        x2: mirrorX(94),
        y2: 362,
      }),
      part("hoodie-back-body-outline", "path", "outline", {
        d:
          "M 242 162 C 298 128 352 120 400 122 C 448 120 502 128 558 162 " +
          "L 546 732 C 536 760 264 760 254 732 Z",
      }),
      part("hoodie-back-hood-outline", "path", "outline", {
        d:
          "M 265 162 C 285 48 515 48 535 162 C 490 138 310 138 265 162 Z",
      }),
      part("hoodie-back-l-sleeve-outline", "polygon", "outline", {
        points: "64,202 180,158 220,228 210,342 94,362 60,282",
      }),
      part("hoodie-back-r-sleeve-outline", "polygon", "outline", {
        points: mirrorPoints([
          [64, 202],
          [180, 158],
          [220, 228],
          [210, 342],
          [94, 362],
          [60, 282],
        ]),
      }),
    ];
  }

  var GARMENT_TYPES = [
    {
      id: "tee",
      label: "T-shirt",
      views: {
        front: {
          /* PLACEHOLDER print area — front tee {x:270,y:190,w:260,h:300} */
          printArea: { x: 270, y: 190, w: 260, h: 300 },
          parts: teeFrontParts(),
        },
        back: {
          /* PLACEHOLDER print area — back tee {x:260,y:170,w:280,h:360} */
          printArea: { x: 260, y: 170, w: 280, h: 360 },
          parts: teeBackParts(),
        },
      },
    },
    {
      id: "polo",
      label: "Polo",
      views: {
        front: {
          /* PLACEHOLDER print area — front polo {x:290,y:200,w:220,h:260} */
          printArea: { x: 290, y: 200, w: 220, h: 260 },
          parts: poloFrontParts(),
        },
        back: {
          /* PLACEHOLDER print area — back polo {x:270,y:170,w:260,h:340} */
          printArea: { x: 270, y: 170, w: 260, h: 340 },
          parts: poloBackParts(),
        },
      },
    },
    {
      id: "jersey",
      label: "Jersey",
      views: {
        front: {
          /* PLACEHOLDER print area — front jersey {x:260,y:190,w:280,h:340} */
          printArea: { x: 260, y: 190, w: 280, h: 340 },
          parts: jerseyFrontParts(),
        },
        back: {
          /* PLACEHOLDER print area — back jersey {x:250,y:170,w:300,h:380} */
          printArea: { x: 250, y: 170, w: 300, h: 380 },
          parts: jerseyBackParts(),
        },
      },
    },
    {
      id: "hoodie",
      label: "Hoodie",
      views: {
        front: {
          /* PLACEHOLDER print area — front hoodie {x:270,y:230,w:260,h:260} */
          printArea: { x: 270, y: 230, w: 260, h: 260 },
          parts: hoodieFrontParts(),
        },
        back: {
          /* PLACEHOLDER print area — back hoodie {x:260,y:260,w:280,h:320} */
          printArea: { x: 260, y: 260, w: 280, h: 320 },
          parts: hoodieBackParts(),
        },
      },
    },
  ];

  var GARMENT_BY_ID = Object.create(null);
  (function indexGarments() {
    for (var i = 0; i < GARMENT_TYPES.length; i++) {
      var g = GARMENT_TYPES[i];
      GARMENT_BY_ID[g.id] = g;
      var v;
      for (v = 0; v < VIEW_IDS.length; v++) {
        var viewId = VIEW_IDS[v];
        if (!g.views[viewId]) {
          g.views[viewId] = { parts: [], printArea: null };
        } else if (!Array.isArray(g.views[viewId].parts)) {
          g.views[viewId].parts = [];
        }
      }
    }
  })();

  function normalizeGarmentId(id) {
    if (id == null || id === "") return "tee";
    var key = String(id).trim().toLowerCase();
    if (key === "t-shirt" || key === "tshirt" || key === "t shirt") return "tee";
    return key;
  }

  function garmentById(id) {
    var key = normalizeGarmentId(id);
    return GARMENT_BY_ID[key] || null;
  }

  function normalizeViewId(viewId) {
    if (viewId == null || viewId === "") return DEFAULT_VIEW;
    var v = String(viewId).trim().toLowerCase();
    return VIEW_IDS.indexOf(v) >= 0 ? v : DEFAULT_VIEW;
  }

  function buildPartsForTest(garmentId, viewId) {
    var g = garmentById(garmentId);
    if (!g || !g.views) return [];
    var view = normalizeViewId(viewId);
    var block = g.views[view];
    if (!block || !Array.isArray(block.parts)) return [];
    return block.parts;
  }

  function ensureSvgLayer(wrap) {
    var svg = document.getElementById("editor-garment-layer");
    if (!svg) {
      svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("id", "editor-garment-layer");
      wrap.insertBefore(svg, wrap.firstChild);
    } else if (svg.parentNode !== wrap) {
      wrap.insertBefore(svg, wrap.firstChild);
    } else if (wrap.firstChild !== svg) {
      wrap.insertBefore(svg, wrap.firstChild);
    }
    svg.setAttribute("viewBox", VIEW_BOX);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("draggable", "false");
    // Match wrap border-box (content-box + border) within 1px for Task 17 bbox check.
    var cs =
      typeof global.getComputedStyle === "function"
        ? global.getComputedStyle(wrap)
        : null;
    var bl = cs ? parseFloat(cs.borderLeftWidth) || 0 : 0;
    var bt = cs ? parseFloat(cs.borderTopWidth) || 0 : 0;
    svg.setAttribute(
      "style",
      "pointer-events:none;user-select:none;position:absolute;left:" +
        -bl +
        "px;top:" +
        -bt +
        "px;width:" +
        wrap.offsetWidth +
        "px;height:" +
        wrap.offsetHeight +
        "px;max-width:none;max-height:none;box-sizing:border-box;margin:0;padding:0;overflow:visible"
    );
    svg.setAttribute("width", String(wrap.offsetWidth));
    svg.setAttribute("height", String(wrap.offsetHeight));
    return svg;
  }

  function ensureChild(parent, tag, dataKey, dataVal) {
    var sel = "[" + dataKey + '="' + dataVal + '"]';
    var el = parent.querySelector(sel);
    if (!el) {
      el = document.createElementNS(SVG_NS, tag);
      el.setAttribute(dataKey, dataVal);
      parent.appendChild(el);
    }
    return el;
  }

  function applyPartShape(el, def) {
    var kind = def.kind;
    var attrs = ["d", "points", "x", "y", "w", "h", "x1", "y1", "x2", "y2"];
    var i;
    for (i = 0; i < attrs.length; i++) {
      el.removeAttribute(attrs[i]);
    }
    el.removeAttribute("width");
    el.removeAttribute("height");
    el.removeAttribute("cx");
    el.removeAttribute("cy");
    el.removeAttribute("r");

    if (kind === "path") {
      if (def.d) el.setAttribute("d", def.d);
    } else if (kind === "polygon") {
      if (def.points) el.setAttribute("points", def.points);
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

  function tagForKind(kind) {
    if (kind === "path") return "path";
    if (kind === "polygon") return "polygon";
    if (kind === "rect") return "rect";
    if (kind === "circle") return "circle";
    if (kind === "line") return "line";
    return "path";
  }

  function stylePart(el, def, fillHex, trimHex) {
    var role = def.role || "fill";
    el.removeAttribute("fill");
    el.removeAttribute("stroke");
    el.removeAttribute("stroke-width");
    el.removeAttribute("stroke-linejoin");
    el.removeAttribute("stroke-linecap");
    el.removeAttribute("opacity");

    if (role === "fill") {
      el.setAttribute("fill", fillHex);
      el.setAttribute("stroke", "none");
    } else if (role === "stroke") {
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", trimHex);
      el.setAttribute("stroke-width", "2");
      el.setAttribute("stroke-linecap", "round");
      el.setAttribute("stroke-linejoin", "round");
    } else if (role === "outline") {
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "rgba(0,0,0,0.25)");
      el.setAttribute("stroke-width", "3");
      el.setAttribute("stroke-linejoin", "round");
      el.setAttribute("stroke-linecap", "round");
    }
  }

  function renderGarmentLayer(garmentId, colorId, viewId) {
    var wrap = document.getElementById("editor-canvas-wrap");
    if (!wrap) return null;

    var garment = garmentById(garmentId) || garmentById("tee");
    var view = normalizeViewId(viewId);
    var color = colorById(colorId);
    var fillHex = color.hex;
    var trimHex = shadeColor(fillHex, -0.25);

    var svg = ensureSvgLayer(wrap);
    var viewDef = garment.views[view] || { parts: [], printArea: null };
    var parts = Array.isArray(viewDef.parts) ? viewDef.parts : [];
    var printArea = viewDef.printArea;

    var printRect = ensureChild(svg, "rect", "data-blytz-layer", "print-area");
    printRect.setAttribute("aria-hidden", "true");
    printRect.setAttribute("fill", "none");
    if (printArea && printArea.w != null && printArea.h != null) {
      printRect.setAttribute("x", String(printArea.x));
      printRect.setAttribute("y", String(printArea.y));
      printRect.setAttribute("width", String(printArea.w));
      printRect.setAttribute("height", String(printArea.h));
      printRect.setAttribute("stroke", contrastColor(fillHex));
      printRect.setAttribute("stroke-width", "2");
      printRect.setAttribute("stroke-dasharray", "8 6");
      printRect.setAttribute("opacity", "0.5");
    } else {
      printRect.setAttribute("width", "0");
      printRect.setAttribute("height", "0");
      printRect.setAttribute("stroke", "none");
      printRect.setAttribute("opacity", "0");
    }

    var partsRoot = ensureChild(svg, "g", "data-blytz-layer", "parts");
    var seen = Object.create(null);
    var p;
    for (p = 0; p < parts.length; p++) {
      var def = parts[p];
      if (!def || !def.id) continue;
      seen[def.id] = true;
      var tag = tagForKind(def.kind);
      var node = partsRoot.querySelector('[data-blytz-part-id="' + def.id + '"]');
      if (!node || node.localName !== tag) {
        if (node && node.parentNode) node.parentNode.removeChild(node);
        node = document.createElementNS(SVG_NS, tag);
        node.setAttribute("data-blytz-part-id", def.id);
        partsRoot.appendChild(node);
      }
      applyPartShape(node, def);
      stylePart(node, def, fillHex, trimHex);
    }

    var existing = partsRoot.querySelectorAll("[data-blytz-part-id]");
    for (p = 0; p < existing.length; p++) {
      var pid = existing[p].getAttribute("data-blytz-part-id");
      if (pid && !seen[pid]) {
        partsRoot.removeChild(existing[p]);
      }
    }

    svg.appendChild(printRect);

    return svg;
  }

  global.BlytzGarments = {
    GARMENT_TYPES: GARMENT_TYPES,
    GARMENT_COLORS: GARMENT_COLORS,
    VIEW_IDS: VIEW_IDS,
    DEFAULT_VIEW: DEFAULT_VIEW,
    garmentById: garmentById,
    colorById: colorById,
    contrastColor: contrastColor,
    shadeColor: shadeColor,
    renderGarmentLayer: renderGarmentLayer,
    buildPartsForTest: buildPartsForTest,
  };
})(typeof window !== "undefined" ? window : globalThis);
