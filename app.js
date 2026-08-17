/**
 * HorizonLock PWA
 * Real-time IMU-based horizon lock + fixed digital zoom.
 * Works in Safari on iPhone (requires HTTPS + user gesture for motion/camera).
 */

(() => {
  // ---------- DOM ----------
  const video        = document.getElementById("camera");
  const processCanvas = document.getElementById("process");
  const outputCanvas  = document.getElementById("output");
  const pCtx         = processCanvas.getContext("2d", { alpha: false });
  const oCtx         = outputCanvas.getContext("2d", { alpha: false });

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
  const SMOOTH = 0.18;                     // low-pass factor
  let animId = null;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;

  // Output size (portrait 1080p-ish). Canvas will be scaled to screen.
  const OUT_W = 1080;
  const OUT_H = 1920;

  // ---------- Orientation (IMU) ----------
  function onDeviceOrientation(e) {
    // On iOS Safari: beta = front-back tilt, gamma = left-right tilt.
    // For a phone held in portrait, the "roll" that tilts the horizon
    // is primarily gamma when upright, but we use a more robust combination.
    // We want the angle that keeps the gravity vector vertical in the image.

    if (e.gamma == null || e.beta == null) return;

    // Convert degrees → radians
    const gamma = e.gamma * Math.PI / 180;   // -90 … 90
    const beta  = e.beta  * Math.PI / 180;   // -180 … 180

    // Approximate roll relative to gravity for a portrait-held phone.
    // This formula works well for normal handheld use and moderate spins.
    // (For full 360° free rotation a more complete rotation-matrix approach
    //  using DeviceMotion accelerationIncludingGravity is better – see below.)
    let rawRoll = Math.atan2(Math.sin(gamma), Math.cos(gamma) * Math.sin(beta));

    // Simple exponential low-pass
    currentRoll = currentRoll * (1 - SMOOTH) + rawRoll * SMOOTH;
  }

  // More robust path using DeviceMotion (accelerationIncludingGravity)
  function onDeviceMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null) return;

    // Gravity vector in device coordinates.
    // When the phone is upright in portrait, gravity ≈ (0, -1, 0) or similar.
    // Roll angle that levels the horizon:
    const rawRoll = Math.atan2(a.x, a.y);   // radians

    currentRoll = currentRoll * (1 - SMOOTH) + rawRoll * SMOOTH;
  }

  async function requestMotionPermission() {
    // iOS 13+ requires explicit permission
    if (typeof DeviceMotionEvent !== "undefined" &&
        typeof DeviceMotionEvent.requestPermission === "function") {
      const state = await DeviceMotionEvent.requestPermission();
      if (state !== "granted") {
        throw new Error("Motion permission denied");
      }
    }
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      const state = await DeviceOrientationEvent.requestPermission();
      if (state !== "granted") {
        throw new Error("Orientation permission denied");
      }
    }

    // Prefer DeviceMotion (includes gravity) when available
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

    // Match process canvas to the actual video resolution
    processCanvas.width  = video.videoWidth  || 1920;
    processCanvas.height = video.videoHeight || 1080;

    // Output canvas stays at fixed size for consistent recording
    outputCanvas.width  = OUT_W;
    outputCanvas.height = OUT_H;

    // Also size the visible canvas CSS to fill the screen (object-fit: cover)
    resizeOutput();
  }

  function resizeOutput() {
    // The canvas element itself is already OUT_W × OUT_H.
    // CSS makes it cover the viewport.
    outputCanvas.style.width  = "100%";
    outputCanvas.style.height = "100%";
  }

  // ---------- Frame processing (horizon lock + fixed zoom) ----------
  function drawFrame() {
    if (video.readyState < 2) {
      animId = requestAnimationFrame(drawFrame);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const pw = processCanvas.width;
    const ph = processCanvas.height;

    // 1. Draw the raw camera frame into the processing canvas
    pCtx.save();
    pCtx.clearRect(0, 0, pw, ph);

    // Mirror front camera
    if (facingMode === "user") {
      pCtx.translate(pw, 0);
      pCtx.scale(-1, 1);
    }
    pCtx.drawImage(video, 0, 0, pw, ph);
    pCtx.restore();

    // 2. Now draw from processCanvas → outputCanvas with rotation + fixed zoom + centre crop
    oCtx.save();
    oCtx.clearRect(0, 0, OUT_W, OUT_H);

    // Move origin to centre of output
    oCtx.translate(OUT_W / 2, OUT_H / 2);

    // Apply horizon-lock rotation (negative so the world stays level)
    oCtx.rotate(-currentRoll);

    // Fixed digital zoom (this is the overscan that prevents FOV pumping)
    const scale = zoom;

    // Source aspect vs destination aspect
    // We scale so that the *cropped* region still covers the output after rotation.
    // Simple approach: scale the source so its shorter side * zoom covers the longer output side.
    const srcAspect = pw / ph;
    const dstAspect = OUT_W / OUT_H;

    let drawW, drawH;
    if (srcAspect > dstAspect) {
      // source is wider → fit height then zoom
      drawH = OUT_H * scale;
      drawW = drawH * srcAspect;
    } else {
      drawW = OUT_W * scale;
      drawH = drawW / srcAspect;
    }

    oCtx.drawImage(
      processCanvas,
      -drawW / 2,
      -drawH / 2,
      drawW,
      drawH
    );

    oCtx.restore();

    animId = requestAnimationFrame(drawFrame);
  }

  // ---------- Recording ----------
  function startRecording() {
    if (isRecording) return;

    recordedChunks = [];
    const canvasStream = outputCanvas.captureStream(30);

    // Add the original audio track if present
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length) {
      canvasStream.addTrack(audioTracks[0]);
    }

    const options = { mimeType: "video/webm;codecs=vp9,opus" };
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = "video/webm;codecs=vp8,opus";
    }
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
      options.mimeType = "video/mp4"; // Safari fallback
    }

    try {
      mediaRecorder = new MediaRecorder(canvasStream, options);
    } catch (err) {
      alert("Recording not supported on this browser: " + err.message);
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `HorizonLock_${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };

    mediaRecorder.start(100); // timeslice for smoother data
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

  // ---------- UI handlers ----------
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

  // Service worker (PWA installability)
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(console.warn);
  }
})();