/**
 * HorizonLock PWA  v1.9
 *
 * - Request up to 240 fps capture
 * - Drop blurry / high-motion frames → steady 30 fps output
 * - Gyro prediction to reduce IMU lag
 * - Manual rotate button (0/90/180/270)
 */

(() => {
  const VERSION = "v1.9";

  const video         = document.getElementById("camera");
  const processCanvas = document.getElementById("process");
  const outputCanvas  = document.getElementById("output");
  const pCtx          = processCanvas.getContext("2d", { alpha: false, willReadFrequently: false });
  const oCtx          = outputCanvas.getContext("2d", { alpha: false });

  // Small canvas for blur (sharpness) sampling – fast
  const sharpCanvas = document.createElement("canvas");
  sharpCanvas.width = 64;
  sharpCanvas.height = 64;
  const sCtx = sharpCanvas.getContext("2d", { willReadFrequently: true });

  const btnStart     = document.getElementById("btn-start");
  const btnFlip      = document.getElementById("btn-flip");
  const btnRecord    = document.getElementById("btn-record");
  const zoomSlider   = document.getElementById("zoom");
  const zoomLabel    = document.getElementById("zoom-label");
  const recIndicator = document.getElementById("rec-indicator");
  const gate         = document.getElementById("permission-gate");
  const controls     = document.getElementById("controls");

  let stream = null;
  let facingMode = "environment";
  let zoom = 1.7;
  let currentRoll = 0;          // smoothed + predicted roll (radians)
  let gyroZ = 0;                // rad/s around view axis (approx)
  const SMOOTH = 0.18;
  const PREDICT_SEC = 0.045;    // predict ~45 ms ahead to counter IMU/display lag
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let rotStep = 0;              // 0..3 → 0/90/180/270°

  // 30 fps output gating
  const OUTPUT_FPS = 30;
  const OUTPUT_INTERVAL = 1000 / OUTPUT_FPS;
  let lastOutputTime = 0;
  let bestSharpness = -1;
  let pendingFrame = false;

  // Motion threshold: if |gyro| above this, treat as blur-risk
  const GYRO_BLUR_THRESH = 1.8; // rad/s ≈ 100°/s

  let actualFps = 0;
  let fpsCount = 0;
  let fpsLast = performance.now();
  let droppedBlur = 0;

  const OUT_W = 1080;
  const OUT_H = 1920;

  // ---------- IMU + gyro prediction ----------
  function onDeviceMotion(e) {
    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;

    if (a && a.x != null && a.y != null) {
      let raw = Math.atan2(a.x, -a.y);
      const upright = Math.min(1, Math.abs(a.y) + 0.25);
      raw *= upright;
      // Low-pass the gravity-derived roll
      currentRoll = currentRoll * (1 - SMOOTH) + raw * SMOOTH;
    }

    // rotationRate: alpha/beta/gamma in deg/s on many browsers; on iOS often deg/s
    if (r) {
      // Prefer gamma (roll rate) when available; fallback to alpha
      const deg = (r.gamma != null) ? r.gamma : (r.alpha != null ? r.alpha : 0);
      gyroZ = deg * Math.PI / 180; // → rad/s
    }
  }

  function predictedRoll() {
    // Extrapolate a few ms ahead using current angular velocity
    return currentRoll + gyroZ * PREDICT_SEC;
  }

  async function requestMotionPermission() {
    if (typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function") {
      const state = await DeviceMotionEvent.requestPermission();
      if (state !== "granted") throw new Error("Motion permission denied");
    }
    window.addEventListener("devicemotion", onDeviceMotion, true);
  }

  // ---------- Camera (request high fps) ----------
  async function startCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());

    // Try 240 → 120 → 60 → 30
    const attempts = [
      { width: 1280, height: 720,  frameRate: 240 },
      { width: 1280, height: 720,  frameRate: 120 },
      { width: 1920, height: 1080, frameRate: 60 },
      { width: 1080, height: 1920, frameRate: 30 }
    ];

    let lastErr = null;
    for (const v of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: true,
          video: {
            facingMode: { ideal: facingMode },
            width:  { ideal: v.width },
            height: { ideal: v.height },
            frameRate: { ideal: v.frameRate, max: v.frameRate }
          }
        });
        break;
      } catch (err) {
        lastErr = err;
        stream = null;
      }
    }
    if (!stream) throw lastErr || new Error("Could not open camera");

    video.srcObject = stream;
    await video.play();
    await new Promise(r => requestAnimationFrame(r));

    processCanvas.width  = video.videoWidth  || 1080;
    processCanvas.height = video.videoHeight || 1920;
    outputCanvas.width   = OUT_W;
    outputCanvas.height  = OUT_H;
    resizeOutput();

    // Report actual track settings
    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings ? track.getSettings() : {};
    actualFps = settings.frameRate || 0;
  }

  function resizeOutput() {
    outputCanvas.style.width  = "100%";
    outputCanvas.style.height = "100%";
  }

  // ---------- Sharpness (blur detection) ----------
  function measureSharpness() {
    // Downscale to 64×64 and compute simple gradient energy
    sCtx.drawImage(processCanvas, 0, 0, 64, 64);
    let data;
    try {
      data = sCtx.getImageData(0, 0, 64, 64).data;
    } catch {
      return 100; // assume ok if blocked
    }
    let sum = 0;
    // Horizontal differences only (fast)
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 63; x++) {
        const i = (y * 64 + x) * 4;
        const j = i + 4;
        const g1 = data[i] * 0.3 + data[i+1] * 0.6 + data[i+2] * 0.1;
        const g2 = data[j] * 0.3 + data[j+1] * 0.6 + data[j+2] * 0.1;
        const d = g1 - g2;
        sum += d * d;
      }
    }
    return sum / (64 * 63);
  }

  // ---------- Draw / select frames ----------
  function processIncoming() {
    if (video.readyState < 2) {
      requestAnimationFrame(processIncoming);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const now = performance.now();

    // FPS counter (incoming)
    fpsCount++;
    if (now - fpsLast >= 1000) {
      actualFps = fpsCount;
      fpsCount = 0;
      fpsLast = now;
    }

    // 1. Camera → processCanvas
    pCtx.save();
    pCtx.clearRect(0, 0, vw, vh);
    if (facingMode === "user") {
      pCtx.translate(vw, 0);
      pCtx.scale(-1, 1);
    }
    pCtx.drawImage(video, 0, 0, vw, vh);
    pCtx.restore();

    // 2. Blur / motion reject
    const highMotion = Math.abs(gyroZ) > GYRO_BLUR_THRESH;
    let sharpness = 0;
    if (!highMotion) {
      sharpness = measureSharpness();
    } else {
      droppedBlur++;
    }

    // Keep the sharpest frame since last output
    if (!highMotion && sharpness >= bestSharpness) {
      bestSharpness = sharpness;
      pendingFrame = true;
      // Render this candidate into output immediately (we'll gate display rate below)
      renderToOutput(vw, vh);
    }

    // 3. Emit to screen / recorder at 30 fps using best frame in the window
    if (now - lastOutputTime >= OUTPUT_INTERVAL) {
      if (pendingFrame) {
        // output canvas already holds the best frame
        lastOutputTime = now;
        bestSharpness = -1;
        pendingFrame = false;
      } else if (!highMotion) {
        // No better frame; still refresh so UI doesn't freeze
        renderToOutput(vw, vh);
        lastOutputTime = now;
      }
    }

    requestAnimationFrame(processIncoming);
  }

  function renderToOutput(vw, vh) {
    const angle = rotStep * (Math.PI / 2);
    const swapped = (rotStep % 2 === 1);
    const roll = predictedRoll();

    oCtx.save();
    oCtx.clearRect(0, 0, OUT_W, OUT_H);
    oCtx.translate(OUT_W / 2, OUT_H / 2);
    oCtx.rotate(angle);
    oCtx.rotate(roll);

    const srcW = swapped ? vh : vw;
    const srcH = swapped ? vw : vh;
    const srcAspect = srcW / srcH;
    const dstAspect = OUT_W / OUT_H;
    const scale = zoom;

    let drawW, drawH;
    if (srcAspect > dstAspect) {
      drawH = OUT_H * scale;
      drawW = drawH * srcAspect;
    } else {
      drawW = OUT_W * scale;
      drawH = drawW / srcAspect;
    }

    oCtx.drawImage(processCanvas, -drawW / 2, -drawH / 2, drawW, drawH);
    oCtx.restore();

    // Overlay
    oCtx.save();
    oCtx.fillStyle = "rgba(255,255,255,0.85)";
    oCtx.font = "24px -apple-system, sans-serif";
    oCtx.fillText(VERSION + "  rot=" + (rotStep * 90) + "°", 16, 36);
    oCtx.font = "18px -apple-system, sans-serif";
    oCtx.fillText(vw + "×" + vh + "  in~" + Math.round(actualFps) + "fps → 30fps", 16, 62);
    oCtx.fillText("roll " + (roll * 180 / Math.PI).toFixed(1) + "°  gyro " + (gyroZ * 180 / Math.PI).toFixed(0) + "°/s", 16, 86);
    oCtx.restore();
  }

  // ---------- Recording (30 fps from output canvas) ----------
  function getSupportedMimeType() {
    const candidates = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm"
    ];
    for (const t of candidates) if (MediaRecorder.isTypeSupported(t)) return t;
    return "";
  }

  function startRecording() {
    if (isRecording) return;
    recordedChunks = [];
    // captureStream(30) requests 30 fps from the canvas
    const canvasStream = outputCanvas.captureStream(OUTPUT_FPS);
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) canvasStream.addTrack(audioTracks[0]);

    const mimeType = getSupportedMimeType();
    try {
      mediaRecorder = new MediaRecorder(canvasStream, mimeType ? { mimeType } : {});
    } catch (err) {
      alert("Recording not supported:\n" + err.message);
      return;
    }

    mediaRecorder.ondataavailable = e => { if (e.data && e.data.size) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const type = mediaRecorder.mimeType || "video/mp4";
      const ext  = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(recordedChunks, { type });
      const url  = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "HorizonLock_" + Date.now() + "." + ext;
      a.click();
      URL.revokeObjectURL(url);
    };

    mediaRecorder.start(200);
    isRecording = true;
    btnRecord.classList.add("recording");
    recIndicator.classList.add("recording");
  }

  function stopRecording() {
    if (!isRecording || !mediaRecorder) return;
    mediaRecorder.stop();
    isRecording = false;
    btnRecord.classList.remove("recording");
    recIndicator.classList.remove("recording");
  }

  // ---------- UI ----------
  const btnRotate = document.createElement("button");
  btnRotate.className = "icon-btn";
  btnRotate.title = "Rotate input";
  btnRotate.textContent = "↻";
  btnRotate.style.marginLeft = "8px";
  if (btnFlip && btnFlip.parentNode) {
    btnFlip.parentNode.insertBefore(btnRotate, btnFlip.nextSibling);
  }

  const versionEl = document.createElement("p");
  versionEl.textContent = VERSION;
  versionEl.style.cssText = "margin-top:12px;font-size:13px;opacity:0.5;";
  gate.appendChild(versionEl);

  btnStart.addEventListener("click", async () => {
    btnStart.disabled = true;
    btnStart.textContent = "Requesting permissions…";
    try {
      await requestMotionPermission();
      await startCamera();
      gate.style.display = "none";
      controls.style.display = "flex";
      processIncoming();
    } catch (err) {
      console.error(err);
      alert("Error:\n" + err.message);
      btnStart.disabled = false;
      btnStart.textContent = "Enable Camera & Motion";
    }
  });

  btnFlip.addEventListener("click", async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    try { await startCamera(); } catch (e) { console.error(e); }
  });

  btnRotate.addEventListener("click", () => {
    rotStep = (rotStep + 1) % 4;
  });

  zoomSlider.addEventListener("input", () => {
    zoom = parseFloat(zoomSlider.value);
    zoomLabel.textContent = zoom.toFixed(1) + "×";
  });

  btnRecord.addEventListener("click", () => {
    if (isRecording) stopRecording(); else startRecording();
  });

  window.addEventListener("resize", resizeOutput);
  window.addEventListener("orientationchange", () => setTimeout(resizeOutput, 200));

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL("sw.js", window.location.href).href).catch(console.warn);
  }
})();
