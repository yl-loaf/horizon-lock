/**
 * HorizonLock PWA
 * Real-time IMU-based horizon lock + fixed digital zoom.
 * Works in Safari on iPhone (requires HTTPS + user gesture for motion/camera).
 */

(() => {
  // ---------- DOM ----------
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

  // ---------- State ----------
  let stream = null;
  let facingMode = "environment";          // rear camera
  let zoom = 1.7;
  let currentRoll = 0;                     // radians, filtered
  const SMOOTH = 0.18;
  let animId = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;

  // Fixed output size (portrait)
  const OUT_W = 1080;
  const OUT_H = 1920;

  // ---------- Orientation (IMU) ----------
  // Prefer DeviceMotion (gravity) – more reliable for horizon lock
  function onDeviceMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null) return;

    // Gravity vector → roll angle that keeps the horizon level.
    // Sign is chosen so that tilting the phone left rotates the image the correct way.
    // // (Negated relative to the earlier version that felt flipped.)
    const rawRoll = Math.atan2(a.x, a.y);

    currentRoll = currentRoll * (1 - SMOOTH) + rawRoll * SMOOTH;
  }

  function onDeviceOrientation(e) {
    if (e.gamma == null || e.beta == null) return;
    const gamma = e.gamma * Math.PI / 180;
    const beta  = e.beta  * Math.PI / 180;
    // Same sign convention as DeviceMotion path
    const rawRoll = -Math.atan2(Math.sin(gamma), Math.cos(gamma) * Math.sin(beta));
    currentRoll = currentRoll * (1 - SMOOTH) + rawRoll * SMOOTH;
  }

  async function requestMotionPermission() {
    if (typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function") {
      const state = await DeviceMotionEvent.requestPermission();
      if (state !== "granted") throw new Error("Motion permission denied");
    }
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      const state = await DeviceOrientationEvent.requestPermission();
      if (state !== "granted") throw new Error("Orientation permission denied");
    }

    if (window.DeviceMotionEvent) {
      window.addEventListener("devicemotion", onDeviceMotion, true);
    } else {
      window.addEventListener("deviceorientation", onDeviceOrientation, true);
    }
  }

  // ---------- Camera ----------
  async function startCamera() {
    if (stream) {
      stream.getTracks().forEach(t => t.stop());
    }

    const constraints = {
      audio: true,
      video: {
        facingMode: { ideal: facingMode },
        width:  { ideal: 1920 },
        height: { ideal: 1080 },
        frameRate: { ideal: 30 }
      }
    };

    stream = await navigator.mediaDevices.getUserMedia(constraints);
    video.srcObject = stream;
    await video.play();

    // Wait one frame so videoWidth/Height are reliable
    await new Promise(r => requestAnimationFrame(r));

    // On iOS the rear camera almost always arrives as landscape (w > h)
    // even when the phone is held in portrait. We normalise everything
    // to portrait orientation inside processCanvas.
    const vw = video.videoWidth  || 1920;
    const vh = video.videoHeight || 1080;

    if (vw >= vh) {
      // Landscape buffer → rotate 90° into a portrait process canvas
      processCanvas.width  = vh;
      processCanvas.height = vw;
    } else {
      processCanvas.width  = vw;
      processCanvas.height = vh;
    }

    outputCanvas.width  = OUT_W;
    outputCanvas.height = OUT_H;
    resizeOutput();
  }

  function resizeOutput() {
    outputCanvas.style.width  = "100%";
    outputCanvas.style.height = "100%";
  }

  // ---------- Frame processing ----------
  function drawFrame() {
    if (video.readyState < 2) {
      animId = requestAnimationFrame(drawFrame);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const pw = processCanvas.width;
    const ph = processCanvas.height;
    const isLandscapeBuffer = vw >= vh;

    // 1. Draw camera frame into processCanvas, correctly oriented to portrait
    pCtx.save();
    pCtx.clearRect(0, 0, pw, ph);

    if (isLandscapeBuffer) {
      // Rotate 90° clockwise so the image stands upright in portrait
      // (this also fixes the previous 180° flip)
      pCtx.translate(pw, 0);
      pCtx.rotate(Math.PI / 2);
      // After rotation the drawing size is vh × vw
      if (facingMode === "user") {
        // Front camera needs horizontal mirror after the rotation
        pCtx.translate(0, vw);
        pCtx.scale(1, -1);
      }
      pCtx.drawImage(video, 0, 0, vw, vh);
    } else {
      // Already portrait
      if (facingMode === "user") {
        pCtx.translate(pw, 0);
        pCtx.scale(-1, 1);
      }
      pCtx.drawImage(video, 0, 0, pw, ph);
    }
    pCtx.restore();

    // 2. Horizon-lock rotation + fixed digital zoom + centre crop → outputCanvas
    oCtx.save();
    oCtx.clearRect(0, 0, OUT_W, OUT_H);
    oCtx.translate(OUT_W / 2, OUT_H / 2);

    // Apply the (already correctly signed) roll
    oCtx.rotate(currentRoll);

    const scale = zoom;
    const srcAspect = pw / ph;
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

    animId = requestAnimationFrame(drawFrame);
  }

  // ---------- Recording (prefer MP4) ----------
  function getSupportedMimeType() {
    // Safari on iOS prefers mp4 / H.264
    const candidates = [
      "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
      "video/mp4;codecs=avc1",
      "video/mp4",
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm"
    ];
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
    return "";
  }

  function startRecording() {
    if (isRecording) return;

    recordedChunks = [];
    const canvasStream = outputCanvas.captureStream(30);

    // Keep original audio
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) {
      canvasStream.addTrack(audioTracks[0]);
    }

    const mimeType = getSupportedMimeType();
    const options = mimeType ? { mimeType } : {};

    try {
      mediaRecorder = new MediaRecorder(canvasStream, options);
    } catch (err) {
      alert("Recording not supported on this browser:\n" + err.message);
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const type = mediaRecorder.mimeType || "video/mp4";
      const ext  = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(recordedChunks, { type });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = `HorizonLock_${Date.now()}.${ext}`;
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
      alert("Permission or camera error:\n" + err.message +
            "\n\nMake sure you are on HTTPS and have granted camera + motion access.");
      btnStart.disabled = false;
      btnStart.textContent = "Enable Camera & Motion";
    }
  });

  btnFlip.addEventListener("click", async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    try {
      await startCamera();
    } catch (err) {
      console.error(err);
    }
  });

  zoomSlider.addEventListener("input", () => {
    zoom = parseFloat(zoomSlider.value);
    zoomLabel.textContent = zoom.toFixed(1) + "×";
  });

  btnRecord.addEventListener("click", () => {
    if (isRecording) stopRecording();
    else startRecording();
  });

  window.addEventListener("resize", resizeOutput);
  window.addEventListener("orientationchange", () => setTimeout(resizeOutput, 200));

  // Service worker
  if ("serviceWorker" in navigator) {
    const swUrl = new URL("sw.js", window.location.href).href;
    navigator.serviceWorker.register(swUrl).catch(console.warn);
  }
})();
