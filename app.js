(() => {
  "use strict";

  const canvas = document.querySelector("#handwriting-pad");
  const resultBox = document.querySelector("#recognized-text");
  const clearButton = document.querySelector("#clear-button");
  const undoButton = document.querySelector("#undo-button");
  const slotModeSelect = document.querySelector("#slot-mode");
  const prevSlotButton = document.querySelector("#prev-slot-button");
  const nextSlotButton = document.querySelector("#next-slot-button");
  const actions = document.querySelector(".actions");
  const context = canvas.getContext("2d");
  const strokeCounts = window.JP_STROKE_COUNTS || {};

  const LANGUAGE_CANDIDATES = [{ languages: ["ja"] }, { languages: ["ja-JP"] }];
  const SUPPORTED_POINTER_TYPES = new Set(["mouse", "touch", "stylus"]);
  const MIN_LINE_WIDTH = 6;
  const MAX_LINE_WIDTH = 12;
  const LINE_WIDTH_RATIO = 0.024;
  const INK_COLOR = "#f4f0df";
  const DRAG_START_DISTANCE_MOUSE = 8;
  const DRAG_START_DISTANCE_TOUCH = 10;
  const MIN_RECOGNITION_INK_LENGTH = 36;
  const RECOGNITION_DRAW_DELAY_MS = 140;
  const RECOGNITION_FINISH_DELAY_MS = 70;
  const RECOGNITION_RETRY_DELAY_MS = 120;
  const STABILITY_CONFIRM_DELAY_MS = 260;
  const STABILITY_MIN_CONFIRMATIONS = 2;
  const COMPLEX_STROKE_STABILITY_THRESHOLD = 12;
  const SUPPLEMENTAL_STROKE_COUNTS = Object.freeze({
    "鱸": 27,
  });

  // 学習用の文字枠では、旧字体・異体字候補を現在一般に用いる字体へ寄せる。
  // フリーモードでは原候補を保持する。
  const EDUCATIONAL_GLYPH_NORMALIZATION = Object.freeze({
    "來": "来",
    "學": "学",
    "國": "国",
    "體": "体",
    "會": "会",
    "變": "変",
    "讀": "読",
    "寫": "写",
    "廣": "広",
    "氣": "気",
    "澤": "沢",
    "邊": "辺",
    "邉": "辺",
    "齊": "斉",
    "齋": "斎",
  });

  const STRUCTURAL_ALTERNATIVE_RULES = Object.freeze([
    {
      source: "晴",
      target: "睛",
      test: hasLikelyLeftEyeComponent,
    },
    {
      source: "錆",
      target: "鯖",
      test: hasLikelyLeftFishComponent,
    },
    {
      source: "鳥",
      target: "烏",
      test: hasLikelyCrowStructure,
    },
    {
      source: "天",
      target: "夭",
      test: hasLikelyYouStructure,
    },
  ]);

  const GOOGLE_HANDWRITING_URLS = [
    "https://www.google.com/inputtools/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8",
    "https://inputtools.google.com/request?ime=handwriting&app=mobilesearch&cs=1&oe=UTF-8",
  ];

  function createInputRecord() {
    return {
      strokes: [],
      text: "",
      message: "",
      state: "message",
    };
  }
  const SHINNYOU_CHARS = new Set(
    Array.from(
      "込辻迂迄迅迎近返迫迭述迷追退送逃逆途透逐逓通逝速造逢連逮週進逸遅遇遊運遍過道達違遠遣適遭遮遷選遺避還邁辺邊迦迩逗這逞逡逵逶逹遁遂遜遼遽邂邃邇邉",
    ),
  );

  const state = {
    nativeRecognizer: null,
    nativeDrawing: null,
    pendingPointerId: null,
    pendingStartPoint: null,
    pendingStartTime: 0,
    pendingPointerType: "",
    activePointerId: null,
    activeStrokePoints: null,
    lastPoint: null,
    strokeStartTime: 0,
    slotMode: 1,
    activeSlotIndex: 0,
    slots: Array.from({ length: 4 }, createInputRecord),
    freeInput: createInputRecord(),
    strokes: [],
    recognitionTimer: 0,
    recognitionSerial: 0,
    isRecognizing: false,
    isBusyIndicatorVisible: false,
    needsRecognition: false,
    nativeFailed: false,
    googleFailed: false,
    nextRecognitionDelay: RECOGNITION_RETRY_DELAY_MS,
    candidateStability: {
      text: "",
      signature: "",
      firstSeenAt: 0,
      confirmations: 0,
    },
    canvasCssSize: {
      width: 0,
      height: 0,
    },
  };

  const messages = {
    loading: "準備中...",
    empty: "手書きしてください",
    noCandidate: "候補なし",
    networkUnavailable: "描画はできますが、認識に接続できません",
  };

  state.strokes = state.slots[0].strokes;

  function isFreeMode() {
    return state.slotMode === "free";
  }

  function getVisibleSlotCount() {
    return isFreeMode() ? 0 : Math.max(1, Math.min(4, Number(state.slotMode) || 1));
  }

  function getActiveInputRecord() {
    return isFreeMode() ? state.freeInput : state.slots[state.activeSlotIndex];
  }

  function forEachInputRecord(callback) {
    state.slots.forEach(callback);
    callback(state.freeInput);
  }

  function refreshActiveStrokesReference() {
    state.strokes = getActiveInputRecord().strokes;
  }

  function getLiveResultText() {
    if (isFreeMode()) {
      const record = state.freeInput;
      return record.text || record.message || messages.empty;
    }

    const count = getVisibleSlotCount();
    const chars = state.slots
      .slice(0, count)
      .map((record) => record.text || "□")
      .join("");

    return chars || messages.empty;
  }

  function renderResultArea() {
    resultBox.replaceChildren();
    resultBox.dataset.mode = isFreeMode() ? "free" : "slots";

    if (isFreeMode()) {
      const record = state.freeInput;
      resultBox.dataset.state = record.text ? "" : "message";
      resultBox.textContent = record.text || record.message || messages.empty;
      resultBox.setAttribute("aria-label", getLiveResultText());
      updateBusyIndicator();
      return;
    }

    const count = getVisibleSlotCount();
    resultBox.dataset.state = "slots";
    const grid = document.createElement("span");
    grid.className = "slot-grid";
    grid.style.setProperty("--slot-count", String(count));

    for (let index = 0; index < count; index += 1) {
      const record = state.slots[index];
      const slot = document.createElement("span");
      slot.className = "character-slot";
      slot.dataset.index = String(index);

      if (index === state.activeSlotIndex) {
        slot.classList.add("is-active");
      }

      if (record.text) {
        slot.textContent = record.text;
      } else if (index === state.activeSlotIndex && record.message && record.message !== messages.empty) {
        const message = document.createElement("span");
        message.className = "slot-message";
        message.textContent = record.message;
        slot.append(message);
      }

      grid.append(slot);
    }

    resultBox.append(grid);
    resultBox.setAttribute("aria-label", getLiveResultText());
    updateBusyIndicator();
  }

  function setResult(text, stateName = "result") {
    const record = getActiveInputRecord();

    if (stateName === "result") {
      record.text = text;
      record.message = "";
      record.state = "result";
    } else {
      record.message = text;
      record.state = "message";

      if (text !== messages.empty && text !== messages.loading) {
        record.text = "";
      }
    }

    renderResultArea();
  }

  function clearActiveRecognition() {
    const record = getActiveInputRecord();
    record.text = "";
    record.message = "";
    record.state = "message";
    renderResultArea();
  }

  function updateBusyIndicator() {
    const isBusy = Boolean(state.isBusyIndicatorVisible);

    if (isFreeMode()) {
      resultBox.dataset.busy = isBusy ? "true" : "false";
      return;
    }

    resultBox.dataset.busy = "false";
    resultBox.querySelectorAll(".character-slot").forEach((slot) => {
      const index = Number(slot.dataset.index);
      slot.dataset.busy = isBusy && index === state.activeSlotIndex ? "true" : "false";
    });
  }

  function setBusy(isBusy) {
    state.isBusyIndicatorVisible = Boolean(isBusy);
    updateBusyIndicator();
  }

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const ratio = window.devicePixelRatio || 1;
    const previousSize = state.canvasCssSize;
    const sizeChanged =
      Math.abs(previousSize.width - width) > 0.5 ||
      Math.abs(previousSize.height - height) > 0.5;

    if (sizeChanged && previousSize.width > 0 && previousSize.height > 0) {
      scaleStoredInk(previousSize, { width, height });
      resetNativeDrawing();
      resetCandidateStability();
    }

    state.canvasCssSize = { width, height };
    canvas.width = Math.max(1, Math.round(width * ratio));
    canvas.height = Math.max(1, Math.round(height * ratio));

    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawAllStrokes();
  }

  function scaleStoredInk(fromSize, toSize) {
    const scaleX = toSize.width / fromSize.width;
    const scaleY = toSize.height / fromSize.height;

    if (Math.abs(scaleX - 1) < 0.005 && Math.abs(scaleY - 1) < 0.005) {
      return;
    }

    forEachInputRecord((record) => {
      record.strokes.forEach((stroke) => {
        stroke.forEach((point) => {
          point.x *= scaleX;
          point.y *= scaleY;
        });
      });
    });

    if (state.pendingStartPoint) {
      state.pendingStartPoint.x *= scaleX;
      state.pendingStartPoint.y *= scaleY;
    }
  }

  function getLineWidth() {
    const rect = canvas.getBoundingClientRect();
    const shorterSide = Math.min(rect.width || 0, rect.height || 0);

    return Math.max(
      MIN_LINE_WIDTH,
      Math.min(MAX_LINE_WIDTH, shorterSide * LINE_WIDTH_RATIO),
    );
  }

  function clearCanvas() {
    const rect = canvas.getBoundingClientRect();
    context.clearRect(0, 0, rect.width, rect.height);
  }

  function drawAllStrokes() {
    clearCanvas();
    state.strokes.forEach((stroke) => {
      stroke.forEach((point, index) => {
        drawPoint(point, index === 0 ? null : stroke[index - 1]);
      });
    });
  }

  function drawPoint(point, previousPoint) {
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = INK_COLOR;
    context.fillStyle = INK_COLOR;
    const lineWidth = getLineWidth();

    context.lineWidth = lineWidth;

    if (!previousPoint) {
      context.beginPath();
      context.arc(point.x, point.y, lineWidth / 2, 0, Math.PI * 2);
      context.fill();
      return;
    }

    context.beginPath();
    context.moveTo(previousPoint.x, previousPoint.y);
    context.lineTo(point.x, point.y);
    context.stroke();
  }

  function getCanvasPoint(event) {
    const point = getCanvasCoordinates(event);

    return {
      ...point,
      t: Math.round(performance.now() - state.strokeStartTime),
    };
  }

  function getCanvasCoordinates(event) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
    const y = Math.min(Math.max(event.clientY - rect.top, 0), rect.height);

    return { x, y };
  }

  function hasInk() {
    return state.strokes.some((stroke) => stroke.length > 1);
  }

  function getTotalInkLength() {
    return state.strokes.reduce((total, stroke) => total + getStrokeLength(stroke), 0);
  }

  function hasMeaningfulInk() {
    const bounds = getInkBounds();

    if (!bounds) {
      return false;
    }

    return (
      hasInk() &&
      getTotalInkLength() >= MIN_RECOGNITION_INK_LENGTH &&
      Math.max(bounds.width, bounds.height) >= MIN_RECOGNITION_INK_LENGTH * 0.55
    );
  }

  function getCanvasGuide() {
    const rect = canvas.getBoundingClientRect();
    return {
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    };
  }

  async function queryNativeSupport(constraint) {
    const query =
      navigator.queryHandwritingRecognizer ||
      navigator.queryHandwritingRecognizerSupport;

    if (typeof query !== "function") {
      return true;
    }

    try {
      return Boolean(await query.call(navigator, constraint));
    } catch {
      return true;
    }
  }

  async function createNativeRecognizer() {
    if (
      !window.isSecureContext ||
      typeof navigator.createHandwritingRecognizer !== "function" ||
      typeof window.HandwritingStroke !== "function"
    ) {
      return null;
    }

    for (const constraint of LANGUAGE_CANDIDATES) {
      try {
        if (await queryNativeSupport(constraint)) {
          return await navigator.createHandwritingRecognizer(constraint);
        }
      } catch {
        // Try the next language tag, then fall back to Google Input Tools.
      }
    }

    return null;
  }

  function getInputType() {
    const pointerType = canvas.dataset.lastPointerType;
    return SUPPORTED_POINTER_TYPES.has(pointerType) ? pointerType : undefined;
  }

  function ensureNativeDrawing() {
    if (!state.nativeRecognizer || state.nativeFailed) {
      return null;
    }

    if (!state.nativeDrawing) {
      const hints = {
        recognitionType: isFreeMode() ? "text" : "per-character",
        inputType: getInputType(),
        alternatives: 1,
      };

      Object.keys(hints).forEach((key) => {
        if (hints[key] === undefined) {
          delete hints[key];
        }
      });

      try {
        state.nativeDrawing = state.nativeRecognizer.startDrawing(hints);
      } catch {
        state.nativeDrawing = state.nativeRecognizer.startDrawing({
          recognitionType: "text",
          alternatives: 1,
        });
      }
    }

    state.nativeDrawing.clear();

    for (const stroke of state.strokes) {
      if (stroke.length === 0) {
        continue;
      }

      const nativeStroke = new HandwritingStroke();
      stroke.forEach((point) => {
        nativeStroke.addPoint({
          x: point.x,
          y: point.y,
          t: point.t,
        });
      });
      state.nativeDrawing.addStroke(nativeStroke);
    }

    return state.nativeDrawing;
  }

  async function recognizeWithNative() {
    const drawing = ensureNativeDrawing();

    if (!drawing) {
      return [];
    }

    try {
      const predictions = await drawing.getPrediction();
      return normalizeCandidates(
        predictions?.map((prediction) => prediction?.text) || [],
      );
    } catch {
      state.nativeFailed = true;
      state.nativeDrawing = null;
      return [];
    }
  }

  function buildGoogleInk() {
    return state.strokes
      .filter((stroke) => stroke.length > 0)
      .map((stroke) => [
        stroke.map((point) => Math.round(point.x)),
        stroke.map((point) => Math.round(point.y)),
        stroke.map((point) => Math.round(point.t)),
      ]);
  }

  async function postGooglePayload(url, payload, contentType) {
    const response = await fetch(url, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: {
        "Content-Type": contentType,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Google handwriting request failed: ${response.status}`);
    }

    return response.json();
  }

  function extractCandidatesFromGoogleResponse(data) {
    if (!Array.isArray(data) || data[0] !== "SUCCESS") {
      return [];
    }

    const candidates = [];

    function walk(value) {
      if (typeof value === "string") {
        const text = value.trim();
        if (text) {
          candidates.push(text);
        }
        return;
      }

      if (Array.isArray(value)) {
        value.forEach(walk);
      }
    }

    walk(data[1]);
    return normalizeCandidates(candidates);
  }

  async function recognizeWithGoogle() {
    const guide = getCanvasGuide();
    const payload = {
      device: navigator.userAgent,
      options: "enable_pre_space",
      requests: [
        {
          writing_guide: {
            writing_area_width: guide.width,
            writing_area_height: guide.height,
          },
          ink: buildGoogleInk(),
          language: "ja",
        },
      ],
    };

    const contentTypes = ["text/plain;charset=UTF-8", "application/json"];

    for (const url of GOOGLE_HANDWRITING_URLS) {
      for (const contentType of contentTypes) {
        try {
          const data = await postGooglePayload(url, payload, contentType);
          const candidates = extractCandidatesFromGoogleResponse(data);

          if (candidates.length > 0) {
            state.googleFailed = false;
            return candidates;
          }
        } catch {
          // Try the next endpoint/content-type pair.
        }
      }
    }

    state.googleFailed = true;
    return [];
  }

  function normalizeCandidates(candidates) {
    const seen = new Set();
    const normalized = [];

    for (const candidate of candidates) {
      const rawText = String(candidate || "").trim();
      const text = !isFreeMode() && getCharacterLength(rawText) === 1
        ? EDUCATIONAL_GLYPH_NORMALIZATION[rawText] || rawText
        : rawText;

      if (!text || seen.has(text)) {
        continue;
      }

      seen.add(text);
      normalized.push(text);
    }

    return normalized;
  }

  function getCharStrokeCount(char) {
    const count = Number.isFinite(strokeCounts[char])
      ? strokeCounts[char]
      : SUPPLEMENTAL_STROKE_COUNTS[char];

    return Number.isFinite(count) ? count : null;
  }

  function getCandidateStrokeCount(text) {
    let total = 0;

    for (const char of Array.from(text)) {
      const count = getCharStrokeCount(char);

      if (!Number.isFinite(count)) {
        return null;
      }

      total += count;
    }

    return total || null;
  }

  function isCjkIdeograph(char) {
    return /^[\u3400-\u9fff]$/u.test(char);
  }

  function hasUnknownKanjiStrokeCount(text) {
    return Array.from(text).some((char) => {
      return isCjkIdeograph(char) && !Number.isFinite(getCharStrokeCount(char));
    });
  }

  function isKanaOnly(text) {
    return /^[\u3040-\u30ffー]+$/u.test(text);
  }

  function isJapaneseCandidate(text) {
    return (
      /[\u3040-\u30ff\u3400-\u9fff]/u.test(text) &&
      /^[\u3040-\u30ff\u3400-\u9fff々〆〤ヶヵー]+$/u.test(text)
    );
  }

  function getCharacterLength(text) {
    return Array.from(text).length;
  }

  function isAllowedCandidateForCurrentMode(text) {
    return isFreeMode() || getCharacterLength(text) === 1;
  }

  function getStrokeTolerance(expectedCount, text) {
    if (isKanaOnly(text)) {
      return 1;
    }

    return 0;
  }

  function getStrokeLength(stroke) {
    let length = 0;

    for (let index = 1; index < stroke.length; index += 1) {
      length += getDistance(stroke[index - 1], stroke[index]);
    }

    return length;
  }

  function getDistance(a, b) {
    return Math.hypot(b.x - a.x, b.y - a.y);
  }

  function getInkBounds() {
    const points = state.strokes.flat().filter(Boolean);

    if (points.length === 0) {
      return null;
    }

    const bounds = points.reduce(
      (acc, point) => ({
        left: Math.min(acc.left, point.x),
        right: Math.max(acc.right, point.x),
        top: Math.min(acc.top, point.y),
        bottom: Math.max(acc.bottom, point.y),
      }),
      {
        left: Infinity,
        right: -Infinity,
        top: Infinity,
        bottom: -Infinity,
      },
    );

    return {
      ...bounds,
      width: Math.max(1, bounds.right - bounds.left),
      height: Math.max(1, bounds.bottom - bounds.top),
    };
  }

  function clusterNumericBands(values, minGap) {
    const sorted = values
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => a - b);
    const clusters = [];

    sorted.forEach((value) => {
      const cluster = clusters[clusters.length - 1];

      if (!cluster || value - cluster.center > minGap) {
        clusters.push({ center: value, count: 1 });
        return;
      }

      cluster.center = (cluster.center * cluster.count + value) / (cluster.count + 1);
      cluster.count += 1;
    });

    return clusters;
  }

  function getStrokeFeatures() {
    return state.strokes
      .filter((stroke) => stroke.length > 1)
      .map((stroke) => {
        const xs = stroke.map((point) => point.x);
        const ys = stroke.map((point) => point.y);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);

        return {
          left,
          right,
          top,
          bottom,
          width: Math.max(1, right - left),
          height: Math.max(1, bottom - top),
          centerX: (left + right) / 2,
          centerY: (top + bottom) / 2,
          length: getStrokeLength(stroke),
          start: stroke[0],
          end: stroke[stroke.length - 1],
        };
      });
  }

  function getSegmentFeatures(bounds = getInkBounds()) {
    if (!bounds) {
      return [];
    }

    const guide = getCanvasGuide();
    const diagonal = Math.hypot(guide.width, guide.height);
    const minPointDistance = Math.max(5, diagonal * 0.008);
    const minSegmentLength = Math.max(7, diagonal * 0.012);
    const segments = [];

    state.strokes.forEach((stroke) => {
      const simplified = simplifyStroke(stroke, minPointDistance);

      for (let index = 1; index < simplified.length; index += 1) {
        const start = simplified[index - 1];
        const end = simplified[index];
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = Math.hypot(dx, dy);

        if (length < minSegmentLength) {
          continue;
        }

        const left = Math.min(start.x, end.x);
        const right = Math.max(start.x, end.x);
        const top = Math.min(start.y, end.y);
        const bottom = Math.max(start.y, end.y);

        segments.push({
          start,
          end,
          dx,
          dy,
          length,
          left,
          right,
          top,
          bottom,
          centerX: (start.x + end.x) / 2,
          centerY: (start.y + end.y) / 2,
          isHorizontal: Math.abs(dx) >= Math.max(Math.abs(dy) * 1.45, bounds.width * 0.035),
          isVertical: Math.abs(dy) >= Math.max(Math.abs(dx) * 1.35, bounds.height * 0.05),
        });
      }
    });

    return segments;
  }

  function hasLikelyLeftEyeComponent() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const leftRegionRight = bounds.left + bounds.width * 0.46;
    const leftRegionHardRight = bounds.left + bounds.width * 0.54;
    const segments = getSegmentFeatures(bounds);
    const horizontalBands = clusterNumericBands(
      segments
        .filter((segment) => {
          return (
            segment.isHorizontal &&
            segment.length >= Math.max(10, bounds.width * 0.07) &&
            segment.centerX <= leftRegionRight &&
            segment.right <= leftRegionHardRight &&
            segment.centerY >= bounds.top + bounds.height * 0.08 &&
            segment.centerY <= bounds.bottom - bounds.height * 0.05
          );
        })
        .map((segment) => segment.centerY),
      Math.max(8, bounds.height * 0.085),
    );

    const verticals = segments.filter((segment) => {
      return (
        segment.isVertical &&
        segment.centerX <= leftRegionHardRight &&
        segment.length >= Math.max(12, bounds.height * 0.18)
      );
    });

    return horizontalBands.length >= 4 && verticals.length >= 1;
  }

  function hasLikelyLeftFishComponent() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const leftRegionRight = bounds.left + bounds.width * 0.52;
    const lowerLimit = bounds.top + bounds.height * 0.66;
    const features = getStrokeFeatures();
    const lowerDotLikeMarks = features.filter((feature) => {
      return (
        feature.centerX <= leftRegionRight &&
        feature.centerY >= lowerLimit &&
        feature.length >= 5 &&
        feature.length <= Math.max(42, bounds.height * 0.24) &&
        feature.width <= bounds.width * 0.2 &&
        feature.height <= bounds.height * 0.22
      );
    });

    return lowerDotLikeMarks.length >= 3;
  }

  function getHorizontalBands(bounds = getInkBounds()) {
    if (!bounds) {
      return [];
    }

    const segments = getSegmentFeatures(bounds)
      .filter((segment) => segment.isHorizontal && segment.length >= bounds.width * 0.12)
      .map((segment) => ({
        y: segment.centerY,
        left: segment.left,
        right: segment.right,
        length: segment.length,
        centerX: segment.centerX,
      }))
      .sort((a, b) => a.y - b.y);

    const bands = [];
    const gap = Math.max(8, bounds.height * 0.065);

    segments.forEach((segment) => {
      const band = bands[bands.length - 1];

      if (!band || segment.y - band.y > gap) {
        bands.push({ ...segment, count: 1 });
        return;
      }

      band.y = (band.y * band.count + segment.y) / (band.count + 1);
      band.left = Math.min(band.left, segment.left);
      band.right = Math.max(band.right, segment.right);
      band.length = Math.max(band.length, segment.length);
      band.centerX = (band.left + band.right) / 2;
      band.count += 1;
    });

    return bands;
  }

  function hasLikelyCrowStructure() {
    const bounds = getInkBounds();

    if (!bounds) {
      return false;
    }

    const strokeStats = estimateInputStrokeStats();
    const bands = getHorizontalBands(bounds).filter((band) => {
      return band.y <= bounds.top + bounds.height * 0.72;
    });

    // 「烏」は「鳥」より一画少なく、中央の目に当たる横画が少ない。
    return strokeStats.rawCount <= 10 && bands.length <= 4;
  }

  function hasLikelyYouStructure() {
    const bounds = getInkBounds();

    if (!bounds) {
      return false;
    }

    const bands = getHorizontalBands(bounds).filter((band) => {
      return band.y <= bounds.top + bounds.height * 0.5;
    });

    if (bands.length < 2) {
      return false;
    }

    const upper = bands[0];
    const lower = bands[1];
    const upperStroke = getStrokeFeatures()
      .filter((feature) => feature.centerY <= bounds.top + bounds.height * 0.3)
      .sort((a, b) => b.length - a.length)[0];
    const upperSlantsDown = upperStroke
      ? Math.abs(upperStroke.end.y - upperStroke.start.y) > Math.abs(upperStroke.end.x - upperStroke.start.x) * 0.18
      : false;

    return upper.length < lower.length * 0.72 && upperSlantsDown;
  }

  function getUpperBoxAndHorizontalRelation() {
    const bounds = getInkBounds();

    if (!bounds) {
      return null;
    }

    const segments = getSegmentFeatures(bounds);
    const upperLimit = bounds.top + bounds.height * 0.7;
    const shortHorizontals = segments.filter((segment) => {
      return (
        segment.isHorizontal &&
        segment.centerY <= upperLimit &&
        segment.length >= bounds.width * 0.12 &&
        segment.length <= bounds.width * 0.48
      );
    });
    const verticals = segments.filter((segment) => {
      return (
        segment.isVertical &&
        segment.centerY <= upperLimit &&
        segment.length >= bounds.height * 0.1 &&
        segment.length <= bounds.height * 0.4
      );
    });

    let boxCenterY = null;
    for (const horizontal of shortHorizontals) {
      const leftVertical = verticals.find((vertical) => {
        return Math.abs(vertical.centerX - horizontal.left) <= bounds.width * 0.12;
      });
      const rightVertical = verticals.find((vertical) => {
        return Math.abs(vertical.centerX - horizontal.right) <= bounds.width * 0.12;
      });

      if (leftVertical || rightVertical) {
        const related = [horizontal, leftVertical, rightVertical].filter(Boolean);
        boxCenterY = related.reduce((sum, item) => sum + item.centerY, 0) / related.length;
        break;
      }
    }

    if (!Number.isFinite(boxCenterY)) {
      return null;
    }

    const longHorizontal = segments
      .filter((segment) => {
        return (
          segment.isHorizontal &&
          segment.centerY <= upperLimit &&
          segment.length >= bounds.width * 0.42
        );
      })
      .sort((a, b) => Math.abs(a.centerY - boxCenterY) - Math.abs(b.centerY - boxCenterY))[0];

    if (!longHorizontal) {
      return null;
    }

    return longHorizontal.centerY < boxCenterY ? "horizontal-above" : "horizontal-below";
  }

  function countCredibleJoinedCorners() {
    const bounds = getInkBounds();

    if (!bounds) {
      return 0;
    }

    const guide = getCanvasGuide();
    const minDistance = Math.max(8, Math.hypot(guide.width, guide.height) * 0.014);
    const minLeg = Math.max(18, Math.min(bounds.width, bounds.height) * 0.1);
    let count = 0;

    state.strokes.forEach((stroke) => {
      const points = simplifyStroke(stroke, minDistance);

      for (let index = 1; index < points.length - 1; index += 1) {
        const a = points[index - 1];
        const b = points[index];
        const c = points[index + 1];
        const lenA = getDistance(a, b);
        const lenB = getDistance(b, c);

        if (lenA < minLeg || lenB < minLeg) {
          continue;
        }

        const dot = (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot / (lenA * lenB))));

        if (angle >= Math.PI * 0.32 && angle <= Math.PI * 0.72) {
          count += 1;
        }
      }
    });

    return count;
  }

  function hasRequiredCandidateStructure(text) {
    if (text === "感") {
      return getUpperBoxAndHorizontalRelation() === "horizontal-above";
    }

    if (text === "惑") {
      return getUpperBoxAndHorizontalRelation() === "horizontal-below";
    }

    if (text === "天" && hasLikelyYouStructure()) {
      return false;
    }

    if (text === "鳥" && hasLikelyCrowStructure()) {
      return false;
    }

    return true;
  }

  function simplifyStroke(stroke, minDistance) {
    if (stroke.length <= 2) {
      return stroke.slice();
    }

    const simplified = [stroke[0]];
    let last = stroke[0];

    for (let index = 1; index < stroke.length - 1; index += 1) {
      const point = stroke[index];

      if (getDistance(last, point) >= minDistance) {
        simplified.push(point);
        last = point;
      }
    }

    simplified.push(stroke[stroke.length - 1]);
    return simplified;
  }

  function estimateSegmentsInStroke(stroke, guide) {
    if (stroke.length < 2) {
      return 0;
    }

    const diagonal = Math.hypot(guide.width, guide.height);
    const minPointDistance = Math.max(7, diagonal * 0.012);
    const minSectionLength = Math.max(24, diagonal * 0.04);
    const simplified = simplifyStroke(stroke, minPointDistance);

    if (simplified.length < 3) {
      return 1;
    }

    let segments = 1;
    let distanceSinceBreak = 0;
    let remainingLength = 0;
    const lengths = [];

    for (let index = 1; index < simplified.length; index += 1) {
      const length = getDistance(simplified[index - 1], simplified[index]);
      lengths.push(length);
      remainingLength += length;
    }

    for (let index = 1; index < simplified.length - 1; index += 1) {
      const before = simplified[index - 1];
      const current = simplified[index];
      const after = simplified[index + 1];
      const lenA = getDistance(before, current);
      const lenB = getDistance(current, after);

      distanceSinceBreak += lengths[index - 1] || 0;
      remainingLength -= lengths[index - 1] || 0;

      if (lenA < minPointDistance || lenB < minPointDistance) {
        continue;
      }

      const dot =
        (current.x - before.x) * (after.x - current.x) +
        (current.y - before.y) * (after.y - current.y);
      const ratio = Math.max(-1, Math.min(1, dot / (lenA * lenB)));
      const turn = Math.acos(ratio);

      if (
        turn > Math.PI * 0.58 &&
        distanceSinceBreak >= minSectionLength &&
        remainingLength >= minSectionLength
      ) {
        segments += 1;
        distanceSinceBreak = 0;
      }
    }

    return Math.max(1, segments);
  }

  function estimateInputStrokeStats() {
    const guide = getCanvasGuide();
    const rawCount = state.strokes.filter((stroke) => stroke.length > 1).length;
    const virtualCount = state.strokes.reduce((total, stroke) => {
      return total + estimateSegmentsInStroke(stroke, guide);
    }, 0);

    return {
      rawCount,
      virtualCount: Math.max(rawCount, virtualCount),
    };
  }

  function hasShinnyouChar(text) {
    return Array.from(text).some((char) => SHINNYOU_CHARS.has(char));
  }

  function hasCompletedShinnyouSweep() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const guide = getCanvasGuide();
    const diagonal = Math.hypot(guide.width, guide.height);
    const minPointDistance = Math.max(7, diagonal * 0.012);
    const bottomBandTop = bounds.top + bounds.height * 0.68;
    const minSweepDx = Math.max(bounds.width * 0.5, guide.width * 0.15);

    for (const stroke of state.strokes) {
      const simplified = simplifyStroke(stroke, minPointDistance);
      let runDx = 0;
      let runStartX = null;
      let runEndX = null;

      for (let index = 1; index < simplified.length; index += 1) {
        const before = simplified[index - 1];
        const after = simplified[index];
        const dx = after.x - before.x;
        const dy = after.y - before.y;
        const midY = (before.y + after.y) / 2;
        const isBottom = midY >= bottomBandTop;
        const isRightward = dx > 0;
        const isMostlyHorizontal =
          Math.abs(dy) <= Math.max(Math.abs(dx) * 0.5, bounds.height * 0.08);

        if (isBottom && isRightward && isMostlyHorizontal) {
          runStartX = runStartX ?? before.x;
          runEndX = after.x;
          runDx += dx;

          if (
            runDx >= minSweepDx &&
            runStartX <= bounds.left + bounds.width * 0.38 &&
            runEndX >= bounds.left + bounds.width * 0.72
          ) {
            return true;
          }
        } else {
          runDx = 0;
          runStartX = null;
          runEndX = null;
        }
      }
    }

    return false;
  }

  const SANZUI_CHARS = new Set(
    Array.from(
      "汁汀氾池汐汎汚汝江汲決汽沃沖沈沙没沢河沼沸油治沿況泉泊泣注波泳泥沫法泌泡洋洗洞津洪洲活派流浄浅浜浦浴浮海消涙液涼淑淡深混清済渉渋渓湖湘湯湾湿満源準滞漁演漠漢漬漸潔潜潟潤澄濁濃濯瀬瀕灌",
    ),
  );

  function hasSanzuiChar(text) {
    return Array.from(text).some((char) => SANZUI_CHARS.has(char));
  }

  function hasCompletedSanzui() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const leftLimit = bounds.left + bounds.width * 0.42;
    const marks = state.strokes
      .filter((stroke) => stroke.length > 1)
      .map((stroke) => {
        const start = stroke[0];
        const end = stroke[stroke.length - 1];
        const xs = stroke.map((point) => point.x);
        const ys = stroke.map((point) => point.y);
        const left = Math.min(...xs);
        const right = Math.max(...xs);
        const top = Math.min(...ys);
        const bottom = Math.max(...ys);
        const centerX = (left + right) / 2;
        const centerY = (top + bottom) / 2;
        const dx = end.x - start.x;
        const dy = end.y - start.y;
        const length = getStrokeLength(stroke);

        return {
          centerX,
          centerY,
          dx,
          dy,
          length,
          isLeft: centerX <= leftLimit,
        };
      })
      .filter((mark) => mark.isLeft && mark.length >= 8);

    const topMark = marks.some(
      (mark) => mark.centerY <= bounds.top + bounds.height * 0.4 && mark.dy > 2,
    );
    const middleMark = marks.some(
      (mark) =>
        mark.centerY > bounds.top + bounds.height * 0.25 &&
        mark.centerY < bounds.top + bounds.height * 0.72 &&
        mark.dy > 2,
    );
    const lowerSweep = marks.some(
      (mark) =>
        mark.centerY >= bounds.top + bounds.height * 0.58 &&
        mark.dx > 6 &&
        Math.abs(mark.dx) >= Math.abs(mark.dy) * 0.6,
    );

    return topMark && middleMark && lowerSweep;
  }

  const KUSAKANMURI_CHARS = new Set(
    Array.from(
      "花芳芸芽苗若苦英茂茎草荒荘荷菊菌菓菜華菩萎著葬蒸蓄蔵薄薦薫薬藩藤藍蘇蘭漢范",
    ),
  );

  function hasKusakanmuriChar(text) {
    return Array.from(text).some((char) => KUSAKANMURI_CHARS.has(char));
  }

  function hasCompletedKusakanmuriTop() {
    const bounds = getInkBounds();

    if (!bounds || bounds.width < 1 || bounds.height < 1) {
      return false;
    }

    const topLimit = bounds.top + bounds.height * 0.34;
    const topStrokes = state.strokes.filter((stroke) => {
      if (stroke.length < 2) {
        return false;
      }

      const xs = stroke.map((point) => point.x);
      const ys = stroke.map((point) => point.y);
      const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
      return centerY <= topLimit;
    });
    const horizontal = topStrokes.some((stroke) => {
      const start = stroke[0];
      const end = stroke[stroke.length - 1];
      return Math.abs(end.x - start.x) > bounds.width * 0.16;
    });
    const verticalishMarks = topStrokes.filter((stroke) => {
      const start = stroke[0];
      const end = stroke[stroke.length - 1];
      return Math.abs(end.y - start.y) > 10;
    }).length;

    return horizontal && verticalishMarks >= 2;
  }

  function getAllowedRawShortfall(expectedCount, text) {
    if (isKanaOnly(text) || isFreeMode()) {
      return isKanaOnly(text) ? expectedCount : Math.min(2, Math.floor(expectedCount * 0.18));
    }

    // 文字枠モードは学習用途なので、単なる曲線や崩れを「つなげ書き」と数えない。
    // 明確な折れが存在する場合に限り、一画までの結合を認める。
    const joinedCorners = countCredibleJoinedCorners();
    return joinedCorners >= 1 && expectedCount >= 5 ? 1 : 0;
  }

  function getAllowedRawOverage(text) {
    if (isFreeMode() || isKanaOnly(text)) {
      return 1;
    }

    return 0;
  }

  function isStrokeCompatible(text, strokeStats) {
    const expectedCount = getCandidateStrokeCount(text);

    if (!expectedCount) {
      return isFreeMode();
    }

    if (!hasRequiredCandidateStructure(text)) {
      return false;
    }

    if (hasShinnyouChar(text) && !hasCompletedShinnyouSweep()) {
      return false;
    }

    if (hasSanzuiChar(text) && !hasCompletedSanzui()) {
      return false;
    }

    if (hasKusakanmuriChar(text) && !hasCompletedKusakanmuriTop()) {
      return false;
    }

    const tolerance = getStrokeTolerance(expectedCount, text);
    const allowedRawShortfall = getAllowedRawShortfall(expectedCount, text);
    const allowedRawOverage = getAllowedRawOverage(text);

    return (
      strokeStats.virtualCount + tolerance >= expectedCount &&
      strokeStats.rawCount >= expectedCount - allowedRawShortfall &&
      strokeStats.rawCount <= expectedCount + allowedRawOverage
    );
  }

  function canUseStructuralAlternative(rule, strokeStats) {
    if (typeof rule.test !== "function" || !rule.test(strokeStats)) {
      return false;
    }

    return isStrokeCompatible(rule.target, strokeStats);
  }

  function expandStructuralAlternatives(candidates, strokeStats) {
    const expanded = [];
    const seen = new Set();

    function push(text) {
      if (!seen.has(text)) {
        seen.add(text);
        expanded.push(text);
      }
    }

    candidates.forEach((candidate) => {
      STRUCTURAL_ALTERNATIVE_RULES.forEach((rule) => {
        if (candidate === rule.source && canUseStructuralAlternative(rule, strokeStats)) {
          push(rule.target);
        }
      });

      push(candidate);
    });

    return expanded;
  }

  function getCandidateStrokeRank(text, strokeStats, originalIndex) {
    const expectedCount = getCandidateStrokeCount(text);

    if (!Number.isFinite(expectedCount)) {
      return 1000 + originalIndex * 0.01;
    }

    const virtualDistance = Math.abs(strokeStats.virtualCount - expectedCount);
    const rawDistance = Math.abs(strokeStats.rawCount - expectedCount);
    const overagePenalty = Math.max(0, strokeStats.rawCount - expectedCount) * 0.35;

    return virtualDistance * 3 + rawDistance * 0.55 + overagePenalty + originalIndex * 0.01;
  }

  function orderCandidatesByStrokeFit(candidates, strokeStats) {
    return candidates
      .map((text, index) => ({
        text,
        rank: getCandidateStrokeRank(text, strokeStats, index),
      }))
      .sort((a, b) => a.rank - b.rank)
      .map((entry) => entry.text);
  }

  function selectDisplayCandidate(candidates, strokeStats = estimateInputStrokeStats()) {
    const normalized = normalizeCandidates(candidates);

    if (normalized.length === 0) {
      return "";
    }

    const structurallyExpanded = expandStructuralAlternatives(normalized, strokeStats);
    const japaneseCandidates = structurallyExpanded
      .filter(isJapaneseCandidate)
      .filter(isAllowedCandidateForCurrentMode);

    if (japaneseCandidates.length === 0) {
      return "";
    }

    const compatibleCandidates = japaneseCandidates.filter((text) =>
      isStrokeCompatible(text, strokeStats),
    );

    if (compatibleCandidates.length === 0) {
      return "";
    }

    return orderCandidatesByStrokeFit(compatibleCandidates, strokeStats)[0] || "";
  }

  function isPointerInputActive() {
    return (
      state.pendingPointerId !== null ||
      state.activePointerId !== null ||
      Boolean(state.activeStrokePoints)
    );
  }

  function resetCandidateStability() {
    state.candidateStability.text = "";
    state.candidateStability.signature = "";
    state.candidateStability.firstSeenAt = 0;
    state.candidateStability.confirmations = 0;
    state.nextRecognitionDelay = RECOGNITION_RETRY_DELAY_MS;
  }

  function getInkSignature(strokeStats = estimateInputStrokeStats()) {
    const bounds = getInkBounds();

    if (!bounds) {
      return "empty";
    }

    return [
      strokeStats.rawCount,
      strokeStats.virtualCount,
      Math.round(getTotalInkLength() / 8),
      Math.round(bounds.left / 8),
      Math.round(bounds.top / 8),
      Math.round(bounds.width / 8),
      Math.round(bounds.height / 8),
    ].join(":");
  }

  function requiresCandidateStability(text, strokeStats) {
    const expectedCount = getCandidateStrokeCount(text);

    return (
      hasShinnyouChar(text) ||
      hasSanzuiChar(text) ||
      hasKusakanmuriChar(text) ||
      hasUnknownKanjiStrokeCount(text) ||
      (Number.isFinite(expectedCount) &&
        expectedCount >= COMPLEX_STROKE_STABILITY_THRESHOLD) ||
      strokeStats.rawCount >= COMPLEX_STROKE_STABILITY_THRESHOLD
    );
  }

  function getStableCandidateDecision(text, strokeStats) {
    if (!text) {
      resetCandidateStability();
      return { text: "", pending: false };
    }

    if (!requiresCandidateStability(text, strokeStats)) {
      resetCandidateStability();
      return { text, pending: false };
    }

    const signature = getInkSignature(strokeStats);
    const now = performance.now();
    const stability = state.candidateStability;

    if (stability.text !== text || stability.signature !== signature) {
      stability.text = text;
      stability.signature = signature;
      stability.firstSeenAt = now;
      stability.confirmations = 1;
    } else {
      stability.confirmations += 1;
    }

    if (
      !isPointerInputActive() &&
      stability.confirmations >= STABILITY_MIN_CONFIRMATIONS &&
      now - stability.firstSeenAt >= STABILITY_CONFIRM_DELAY_MS * 0.5
    ) {
      return { text, pending: false };
    }

    return {
      text: "",
      pending: true,
      delay: STABILITY_CONFIRM_DELAY_MS,
    };
  }

  function getDragStartDistance(pointerType) {
    return pointerType === "touch"
      ? DRAG_START_DISTANCE_TOUCH
      : DRAG_START_DISTANCE_MOUSE;
  }

  function prepareStroke(event) {
    window.clearTimeout(state.recognitionTimer);
    resetCandidateStability();
    state.pendingPointerId = event.pointerId;
    state.pendingStartPoint = getCanvasCoordinates(event);
    state.pendingStartTime = performance.now();
    state.pendingPointerType = event.pointerType || "";

    if (typeof canvas.setPointerCapture === "function") {
      canvas.setPointerCapture(event.pointerId);
    }
  }

  function startStroke(event) {
    if (!state.pendingStartPoint) {
      return;
    }

    canvas.dataset.lastPointerType = state.pendingPointerType;
    state.recognitionSerial += 1;
    state.strokeStartTime = state.pendingStartTime;
    state.activePointerId = event.pointerId;
    state.activeStrokePoints = [];
    state.lastPoint = null;
    state.strokes.push(state.activeStrokePoints);
    resetCandidateStability();
    clearActiveRecognition();
    updateActionButtons();

    addPreparedPoint(state.pendingStartPoint);
    addPoint(event);
    state.pendingPointerId = null;
    state.pendingStartPoint = null;
    state.pendingPointerType = "";
    setBusy(true);
    scheduleRecognition(RECOGNITION_DRAW_DELAY_MS);
  }

  function addPreparedPoint(point) {
    if (!state.activeStrokePoints) {
      return;
    }

    const preparedPoint = {
      ...point,
      t: 0,
    };

    state.activeStrokePoints.push(preparedPoint);
    drawPoint(preparedPoint, state.lastPoint);
    state.lastPoint = preparedPoint;
  }

  function addPoint(event) {
    if (!state.activeStrokePoints) {
      return;
    }

    const point = getCanvasPoint(event);
    state.activeStrokePoints.push(point);
    drawPoint(point, state.lastPoint);
    state.lastPoint = point;
  }

  function continueStroke(event) {
    if (
      event.pointerId === state.pendingPointerId &&
      state.pendingStartPoint &&
      !state.activeStrokePoints
    ) {
      event.preventDefault();
      const currentPoint = getCanvasCoordinates(event);
      const distance = getDistance(state.pendingStartPoint, currentPoint);

      if (distance >= getDragStartDistance(state.pendingPointerType)) {
        startStroke(event);
      }

      return;
    }

    if (event.pointerId !== state.activePointerId || !state.activeStrokePoints) {
      return;
    }

    event.preventDefault();

    const events =
      typeof event.getCoalescedEvents === "function"
        ? event.getCoalescedEvents()
        : [event];

    events.forEach(addPoint);
    scheduleRecognition(RECOGNITION_DRAW_DELAY_MS);
  }

  function finishStroke(event) {
    if (
      event.pointerId === state.pendingPointerId &&
      state.pendingStartPoint &&
      !state.activeStrokePoints
    ) {
      event.preventDefault();

      if (
        typeof canvas.hasPointerCapture === "function" &&
        canvas.hasPointerCapture(event.pointerId)
      ) {
        canvas.releasePointerCapture(event.pointerId);
      }

      state.pendingPointerId = null;
      state.pendingStartPoint = null;
      state.pendingPointerType = "";
      return;
    }

    if (event.pointerId !== state.activePointerId || !state.activeStrokePoints) {
      return;
    }

    event.preventDefault();

    if (
      typeof canvas.hasPointerCapture === "function" &&
      canvas.hasPointerCapture(event.pointerId)
    ) {
      canvas.releasePointerCapture(event.pointerId);
    }

    state.activePointerId = null;
    state.activeStrokePoints = null;
    state.lastPoint = null;
    scheduleRecognition(RECOGNITION_FINISH_DELAY_MS);
  }

  function scheduleRecognition(delay) {
    if (!hasMeaningfulInk()) {
      if (hasInk()) {
        setResult(messages.noCandidate, "message");
      }

      setBusy(false);
      return;
    }

    setBusy(true);
    window.clearTimeout(state.recognitionTimer);
    state.recognitionTimer = window.setTimeout(runRecognition, delay);
  }

  async function runRecognition() {
    if (!hasMeaningfulInk()) {
      if (hasInk()) {
        setResult(messages.noCandidate, "message");
      }

      setBusy(false);
      return;
    }

    if (state.isRecognizing) {
      state.needsRecognition = true;
      return;
    }

    state.isRecognizing = true;
    const serial = ++state.recognitionSerial;

    try {
      state.nextRecognitionDelay = RECOGNITION_RETRY_DELAY_MS;
      const strokeStats = estimateInputStrokeStats();
      const nativeCandidates = await recognizeWithNative();
      let text = selectDisplayCandidate(nativeCandidates, strokeStats);

      if (!text) {
        text = selectDisplayCandidate(await recognizeWithGoogle(), strokeStats);
      }

      if (serial !== state.recognitionSerial || !hasMeaningfulInk()) {
        return;
      }

      const decision = getStableCandidateDecision(text, strokeStats);

      if (decision.pending) {
        state.needsRecognition = true;
        state.nextRecognitionDelay = decision.delay;
        return;
      }

      if (decision.text) {
        setResult(decision.text, "result");
      } else {
        setResult(
          state.googleFailed ? messages.networkUnavailable : messages.noCandidate,
          "message",
        );
      }
    } finally {
      state.isRecognizing = false;

      if (serial !== state.recognitionSerial) {
        return;
      }

      if (state.needsRecognition) {
        const delay = state.nextRecognitionDelay || RECOGNITION_RETRY_DELAY_MS;
        state.needsRecognition = false;
        state.nextRecognitionDelay = RECOGNITION_RETRY_DELAY_MS;
        scheduleRecognition(delay);
      } else {
        setBusy(false);
      }
    }
  }

  function updateActionButtons() {
    const slotMode = isFreeMode() ? "free" : "slots";
    actions.dataset.slotMode = slotMode;
    undoButton.disabled = state.strokes.length === 0;

    if (isFreeMode()) {
      prevSlotButton.disabled = true;
      nextSlotButton.disabled = true;
      return;
    }

    const count = getVisibleSlotCount();
    prevSlotButton.disabled = state.activeSlotIndex <= 0;
    nextSlotButton.disabled = state.activeSlotIndex >= count - 1;
  }

  function resetNativeDrawing() {
    if (state.nativeDrawing) {
      state.nativeDrawing.clear();
      state.nativeDrawing = null;
    }
  }

  function resetPointerState() {
    state.activePointerId = null;
    state.pendingPointerId = null;
    state.pendingStartPoint = null;
    state.pendingPointerType = "";
    state.activeStrokePoints = null;
    state.lastPoint = null;
  }

  function activateCurrentInput({ recognizeIfNeeded = true } = {}) {
    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
    resetPointerState();
    resetNativeDrawing();
    resetCandidateStability();
    refreshActiveStrokesReference();
    drawAllStrokes();
    renderResultArea();
    updateActionButtons();
    setBusy(false);

    if (recognizeIfNeeded && hasMeaningfulInk() && !getActiveInputRecord().text) {
      setBusy(true);
      scheduleRecognition(RECOGNITION_FINISH_DELAY_MS);
    }
  }

  function setSlotMode(value) {
    state.slotMode = value === "free" ? "free" : Math.max(1, Math.min(4, Number(value) || 1));
    state.activeSlotIndex = 0;
    activateCurrentInput();
  }

  function moveSlot(delta) {
    if (isFreeMode()) {
      return;
    }

    const count = getVisibleSlotCount();
    const nextIndex = Math.max(0, Math.min(count - 1, state.activeSlotIndex + delta));

    if (nextIndex === state.activeSlotIndex) {
      return;
    }

    state.activeSlotIndex = nextIndex;
    activateCurrentInput();
  }

  function undoLastStroke() {
    if (state.strokes.length === 0) {
      return;
    }

    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
    resetPointerState();
    resetNativeDrawing();
    resetCandidateStability();
    state.strokes.pop();
    clearActiveRecognition();
    drawAllStrokes();
    updateActionButtons();

    if (hasMeaningfulInk()) {
      setBusy(true);
      scheduleRecognition(RECOGNITION_FINISH_DELAY_MS);
    } else {
      setBusy(false);
      setResult(hasInk() ? messages.noCandidate : messages.empty, "message");
    }
  }

  function clearPad() {
    window.clearTimeout(state.recognitionTimer);
    state.recognitionSerial += 1;
    resetPointerState();
    resetNativeDrawing();
    resetCandidateStability();
    const record = getActiveInputRecord();
    record.strokes.length = 0;
    record.text = "";
    record.message = "";
    record.state = "message";
    refreshActiveStrokesReference();

    clearCanvas();
    updateActionButtons();
    setBusy(false);
    setResult(messages.empty, "message");
  }

  async function init() {
    setResult(messages.loading, "message");
    resizeCanvas();
    state.nativeRecognizer = await createNativeRecognizer();
    updateActionButtons();
    setBusy(false);
    setResult(messages.empty, "message");
  }

  function preventCanvasGesture(event) {
    event.preventDefault();
  }

  function handleKeyDown(event) {
    if (event.isComposing || event.key.toLowerCase() !== "z") {
      return;
    }

    event.preventDefault();
    undoLastStroke();
  }

  canvas.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    prepareStroke(event);
  });
  canvas.addEventListener("pointermove", continueStroke);
  canvas.addEventListener("pointerup", finishStroke);
  canvas.addEventListener("pointercancel", finishStroke);
  canvas.addEventListener("dblclick", preventCanvasGesture);
  canvas.addEventListener("contextmenu", preventCanvasGesture);
  canvas.addEventListener("selectstart", preventCanvasGesture);
  canvas.addEventListener("dragstart", preventCanvasGesture);
  ["touchstart", "touchmove", "touchend", "touchcancel"].forEach((type) => {
    canvas.addEventListener(type, preventCanvasGesture, { passive: false });
  });
  undoButton.addEventListener("click", undoLastStroke);
  clearButton.addEventListener("click", clearPad);
  slotModeSelect.addEventListener("change", () => setSlotMode(slotModeSelect.value));
  prevSlotButton.addEventListener("click", () => moveSlot(-1));
  nextSlotButton.addEventListener("click", () => moveSlot(1));
  window.addEventListener("keydown", handleKeyDown);

  window.addEventListener("pagehide", () => {
    state.nativeRecognizer?.finish?.();
  });

  new ResizeObserver(resizeCanvas).observe(canvas);
  init();
})();
