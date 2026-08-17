/**
 * HorizonLock PWA  v2.0
 *
 * Simplified real-time path:
 * - No "best frame" buffer (was causing lag)
 * - Always show latest frame, throttled to 30 fps
 * - Lighter gyro prediction
 * - Manual rotate 0/90/180/270
 */

(() => {
  const VERSION = "v2.0";

  const video         = document.getElementById("camera");
  const processCanvas = document.getElementById("process");
  const outputCanvas  = document.getElementById("output");
  const pCtx          = processCanvas.getContext("2d", { alpha: false });
  const oCtx          = outputCanvas.getContext("2d", { alpha: false });

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
  let currentRoll = 0;
  let gyroZ = 0;
  const SMOOTH = 0.22;          // slightly more responsive
  const PREDICT_SEC = 0.02;     // light prediction (~20 ms)
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let rotStep = 0;

  const OUTPUT_FPS = 30;
  const OUTPUT_INTERVAL = 1000 / OUTPUT_FPS;
  let lastOutputTime = 0;

  let displayFps = 0;
  let fpsCount = 0;
  let fpsLast = performance.now();

  const OUT_W = 1080;
  const OUT_H = 1920;

  // ---------- IMU ----------
  function onDeviceMotion(e) {
    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;

    if (a && a.x != null && a.y != null) {
      let raw = Math.atan2(a.x, -a.y);
      const upright = Math.min(1, Math.abs(a.y) + 0.25);
      raw *= upright;
      currentRoll = currentRoll * (1 - SMOOTH) + raw * SMOOTH;
    }

    if (r) {
      const deg = (r.gamma != null) ? r.gamma : (r.alpha != null ? r.alpha : 0);
      gyroZ = deg * Math.PI / 180;
    }
  }

  function predictedRoll() {
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

  // ---------- Camera ----------
  async function startCamera() {
    if (stream) stream.getTracks().forEach(t => t.stop());

    const attempts = [
      { width: 1280, height: 720,  frameRate: 60 },
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
            frameRate: { ideal: v.frameRate }
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
  }

  function resizeOutput() {
    outputCanvas.style.width  = "100%";
    outputCanvas.style.height = "100%";
  }

  // ---------- Simple real-time loop ----------
  function loop() {
    if (video.readyState < 2) {
      requestAnimationFrame(loop);
      return;
    }

    const now = performance.now();

    // Throttle display/record updates to 30 fps – always use the LATEST frame
    if (now - lastOutputTime < OUTPUT_INTERVAL) {
      requestAnimationFrame(loop);
      return;
    }
    lastOutputTime = now;

    fpsCount++;
    if (now - fpsLast >= 1000) {
      displayFps = fpsCount;
      fpsCount = 0;
      fpsLast = now;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // Camera → processCanvas
    pCtx.save();
    if (facingMode === "user") {
      pCtx.setTransform(-1, 0, 0, 1, vw, 0);
    } else {
      pCtx.setTransform(1, 0, 0, 1, 0, 0);
    }
    pCtx.drawImage(video, 0, 0, vw, vh);
    pCtx.restore();

    // Horizon + manual rotate + zoom → output
    const angle = rotStep * (Math.PI / 2);
    const swapped = (rotStep % 2 === 1);
    const roll = predictedRoll();

    oCtx.save();
    oCtx.clearRect(0, 0, OUT_W, OUT_H);
    oCtx.translate(OUT_W / 2, OUT_H / 2);
    oCtx.rotate(angle + roll);

    const srcW = swapped ? vh : vw;
    const srcH = swapped ? vw : vh;
    const srcAspect = srcW / srcH;
    const scale = zoom;

    let drawW, drawH;
    if (srcAspect > OUT_W / OUT_H) {
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
    oCtx.fillText(vw + "×" + vh + "  " + displayFps + " fps", 16, 62);
    oCtx.fillText("roll " + (roll * 180 / Math.PI).toFixed(1) + "°", 16, 86);
    oCtx.restore();

    requestAnimationFrame(loop);
  }

  // ---------- Recording ----------
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
      loop();
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
