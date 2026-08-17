/**
 * HorizonLock PWA  v1.6
 *
 * Complete rethink of orientation:
 * - One clear pipeline for landscape sensor → portrait output
 * - No more random sign flips
 * - Debug info on screen so we can see what the browser actually delivers
 * - Horizon lock applied only after the image is upright
 */

(() => {
  const VERSION = "v1.6";

  // ============================================================
  // ORIENTATION MODE – change this ONE number if still wrong
  // 0 = no extra rotation (raw)
  // 1 = 90° CW
  // 2 = 90° CCW   ← most common correct for iPhone rear camera
  // 3 = 180°
  // ============================================================
  const ORIENT_MODE = 2;

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
  const SMOOTH = 0.12;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;

  const OUT_W = 1080;
  const OUT_H = 1920;

  // ---------- IMU (horizon) ----------
  // Applied AFTER the image is oriented upright, so axes match the picture.
  function onDeviceMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null) return;

    // Phone portrait, screen facing user:
    // +x = right, +y = up.  Roll that levels the horizon:
    let raw = Math.atan2(-a.x, a.y);

    // Soften when nearly flat (avoids wild swings)
    const upright = Math.min(1, Math.abs(a.y) + 0.2);
    raw *= upright;

    currentRoll = currentRoll * (1 - SMOOTH) + raw * SMOOTH;
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

    stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: { ideal: facingMode },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      }
    });
    video.srcObject = stream;
    await video.play();
    await new Promise(r => requestAnimationFrame(r));

    // processCanvas always matches the RAW video size
    processCanvas.width  = video.videoWidth  || 1920;
    processCanvas.height = video.videoHeight || 1080;
    outputCanvas.width   = OUT_W;
    outputCanvas.height  = OUT_H;
    resizeOutput();
  }

  function resizeOutput() {
    outputCanvas.style.width  = "100%";
    outputCanvas.style.height = "100%";
  }

  // ---------- Draw one frame ----------
  function drawFrame() {
    if (video.readyState < 2) {
      requestAnimationFrame(drawFrame);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;

    // 1. Copy camera into processCanvas (mirror only for front)
    pCtx.save();
    pCtx.clearRect(0, 0, vw, vh);
    if (facingMode === "user") {
      pCtx.translate(vw, 0);
      pCtx.scale(-1, 1);
    }
    pCtx.drawImage(video, 0, 0, vw, vh);
    pCtx.restore();

    // 2. Draw processCanvas → outputCanvas with orientation + horizon + zoom
    oCtx.save();
    oCtx.clearRect(0, 0, OUT_W, OUT_H);
    oCtx.translate(OUT_W / 2, OUT_H / 2);

    // Fixed orientation (makes landscape sensor upright in portrait frame)
    let rot = 0;
    if (ORIENT_MODE === 1) rot =  Math.PI / 2;
    if (ORIENT_MODE === 2) rot = -Math.PI / 2;
    if (ORIENT_MODE === 3) rot =  Math.PI;
    oCtx.rotate(rot);

    // Horizon lock (on top of the fixed orientation)
    oCtx.rotate(currentRoll);

    // Cover + digital zoom
    // After ±90° the source axes are swapped for sizing
    const swapped = (ORIENT_MODE === 1 || ORIENT_MODE === 2);
    const srcW = swapped ? vh : vw;
    const srcH = swapped ? vw : vh;
    const scale = zoom;
    const srcAspect = srcW / srcH;
    const dstAspect = OUT_W / OUT_H;

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

    // Version + debug
    oCtx.save();
    oCtx.fillStyle = "rgba(255,255,255,0.85)";
    oCtx.font = "26px -apple-system, sans-serif";
    oCtx.fillText(VERSION + "  mode=" + ORIENT_MODE, 20, 40);
    oCtx.font = "20px -apple-system, sans-serif";
    oCtx.fillText(vw + "×" + vh + (vw >= vh ? " landscape" : " portrait"), 20, 70);
    oCtx.fillText("roll " + (currentRoll * 180 / Math.PI).toFixed(1) + "°", 20, 96);
    oCtx.restore();

    requestAnimationFrame(drawFrame);
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
    const canvasStream = outputCanvas.captureStream(30);
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
      drawFrame();
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
