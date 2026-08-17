/**
 * HorizonLock PWA  v1.5
 *
 * v1.5: fix upside-down image (floor was on top).
 * Extra 180° so the scene is the right way up.
 */

(() => {
  const VERSION = "v1.5";

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
  const SMOOTH = 0.14;
  let mediaRecorder = null;
  let recordedChunks = [];
  let isRecording = false;
  let bufferIsLandscape = true;

  const OUT_W = 1080;
  const OUT_H = 1920;

  // ---------- IMU ----------
  function onDeviceMotion(e) {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null) return;
    // Keep same sign as v1.4 for now; we can flip later if lock still feels inverted
    const rawRoll = -Math.atan2(a.x, a.y);
    currentRoll = currentRoll * (1 - SMOOTH) + rawRoll * SMOOTH;
  }

  function onDeviceOrientation(e) {
    if (e.gamma == null || e.beta == null) return;
    const gamma = e.gamma * Math.PI / 180;
    const beta  = e.beta  * Math.PI / 180;
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

    const vw = video.videoWidth  || 1920;
    const vh = video.videoHeight || 1080;
    bufferIsLandscape = vw >= vh;

    if (bufferIsLandscape) {
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
      requestAnimationFrame(drawFrame);
      return;
    }

    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const pw = processCanvas.width;
    const ph = processCanvas.height;

    pCtx.save();
    pCtx.clearRect(0, 0, pw, ph);

    if (bufferIsLandscape) {
      // v1.5: 90° CW + BOTH axes flipped (= extra 180°) so floor is at the bottom
      pCtx.translate(pw / 2, ph / 2);
      pCtx.rotate(Math.PI / 2);
      pCtx.scale(-1, -1);   // was (1, -1) → now both flipped to fix upside-down

      if (facingMode === "user") {
        pCtx.scale(-1, 1);
      }
      pCtx.drawImage(video, -vh / 2, -vw / 2, vh, vw);
    } else {
      if (facingMode === "user") {
        pCtx.translate(pw, 0);
        pCtx.scale(-1, 1);
      }
      pCtx.drawImage(video, 0, 0, pw, ph);
    }
    pCtx.restore();

    // Horizon lock + zoom
    oCtx.save();
    oCtx.clearRect(0, 0, OUT_W, OUT_H);
    oCtx.translate(OUT_W / 2, OUT_H / 2);
    oCtx.rotate(currentRoll);

    const scale = zoom;
    const srcAspect = pw / ph;
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

    // Version stamp
    oCtx.save();
    oCtx.fillStyle = "rgba(255,255,255,0.8)";
    oCtx.font = "28px -apple-system, BlinkMacSystemFont, sans-serif";
    oCtx.fillText(VERSION, 24, 48);
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
    for (const t of candidates) {
      if (MediaRecorder.isTypeSupported(t)) return t;
    }
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

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      const type = mediaRecorder.mimeType || "video/mp4";
      const ext  = type.includes("mp4") ? "mp4" : "webm";
      const blob = new Blob(recordedChunks, { type });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
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
      alert("Permission or camera error:\n" + err.message);
      btnStart.disabled = false;
      btnStart.textContent = "Enable Camera & Motion";
    }
  });

  btnFlip.addEventListener("click", async () => {
    facingMode = facingMode === "environment" ? "user" : "environment";
    try { await startCamera(); } catch (err) { console.error(err); }
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register(new URL("sw.js", window.location.href).href).catch(console.warn);
  }
})();
