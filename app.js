/**
 * HorizonLock PWA  v2.51
 *
 * - Pitch-stable roll: tilting the phone up/down no longer glitches the lock
 * - Continuous roll (no 180° wrap spin): unwrapped angle so rotation past ±180°
 *   continues the short way instead of spinning the long way around
 * - Complementary filter (gyro + gravity)
 * - IMU delayed to match camera pipeline latency (sync lock to video)
 * - Only corrects roll (horizon), not pitch
 * - Simple real-time path (latest frame @ constant 30 fps)
 * - Manual rotate 0/90/180/270
 */

(() => {
  const VERSION = "v2.53";

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
  let currentRoll = 0;          // continuous (unwrapped) roll in radians
  let gyroRoll = 0;             // rad/s around the roll axis
  // Complementary filter: gyro drives short-term motion, gravity corrects
  // absolute angle. Higher ALPHA_G = less lag on stops / direction changes.
  const ALPHA_G = 0.28;
  // When the phone is pitched far up/down, gravity leaves the screen plane
  // and atan2 becomes noisy. Below this horizontal magnitude we HOLD roll
  // (gyro still integrates).
  const MIN_HORIZONTAL_G = 0.4;
  // Delay applied to IMU so it lines up with the slower camera pipeline.
  // Video is typically behind DeviceMotion on iOS Safari; delaying roll
  // matches the orientation to the pixels being drawn. Tune if needed
  // (try 40–120 ms). Positive = use older roll (IMU delayed).
  const IMU_DELAY_MS = 40;
  // Ring buffer of recent (t, roll) samples for delayed lookup.
  const ROLL_BUF_SIZE = 64;
  const rollBufT = new Float64Array(ROLL_BUF_SIZE);
  const rollBufR = new Float64Array(ROLL_BUF_SIZE);
  let rollBufIdx = 0;
  let rollBufCount = 0;
  let lastMotionTime = 0;
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

  // Shortest angular difference from `from` to `to` (both radians).
  // Result is in (−π, π].
  function shortestDelta(from, to) {
    let d = to - from;
    d = ((d + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
    return d;
  }

  function pushRollSample(t, roll) {
    rollBufT[rollBufIdx] = t;
    rollBufR[rollBufIdx] = roll;
    rollBufIdx = (rollBufIdx + 1) % ROLL_BUF_SIZE;
    if (rollBufCount < ROLL_BUF_SIZE) rollBufCount++;
  }

  // Roll at time targetT (linear interp between surrounding samples).
  // Falls back to latest if buffer is empty or target is too new/old.
  function rollAt(targetT) {
    if (rollBufCount === 0) return currentRoll;

    // Samples are in chronological order in a ring: oldest → newest.
    // Walk from newest backward to find the bracketing pair.
    let newerI = -1;
    let olderI = -1;
    for (let k = 0; k < rollBufCount; k++) {
      const i = (rollBufIdx - 1 - k + ROLL_BUF_SIZE) % ROLL_BUF_SIZE;
      if (rollBufT[i] >= targetT) {
        newerI = i;
      } else {
        olderI = i;
        break;
      }
    }

    if (newerI < 0) {
      // target is newer than everything — use latest
      const i = (rollBufIdx - 1 + ROLL_BUF_SIZE) % ROLL_BUF_SIZE;
      return rollBufR[i];
    }
    if (olderI < 0) {
      // target is older than everything — use oldest available
      return rollBufR[newerI];
    }

    const t0 = rollBufT[olderI];
    const t1 = rollBufT[newerI];
    const r0 = rollBufR[olderI];
    const r1 = rollBufR[newerI];
    if (t1 <= t0) return r1;
    const u = (targetT - t0) / (t1 - t0);
    // Interpolate along shortest arc so we don't cross the ±π seam badly
    // (samples are already continuous/unwrapped, so plain lerp is fine).
    return r0 + (r1 - r0) * u;
  }

  // ---------- IMU: pitch-stable horizon (roll only) ----------
  function onDeviceMotion(e) {
    const now = performance.now();
    const dt = lastMotionTime ? Math.min((now - lastMotionTime) / 1000, 0.05) : 0;
    lastMotionTime = now;

    const a = e.accelerationIncludingGravity;
    const r = e.rotationRate;

    // 1) Integrate gyro first (high-frequency, low lag)
    if (r) {
      // Roll rate ≈ gamma on portrait phone (deg/s → rad/s)
      const deg = (r.gamma != null) ? r.gamma : 0;
      gyroRoll = deg * Math.PI / 180;
      if (dt > 0) {
        currentRoll += gyroRoll * dt;
      }
    }

    // 2) Gravity correction (low-frequency absolute reference)
    if (a && a.x != null && a.y != null && a.z != null) {
      const gx = a.x;
      const gy = a.y;
      const horizontal = Math.hypot(gx, gy);

      // Only correct when enough gravity lies in the screen plane.
      // When you tilt the phone down/up, gravity moves into Z → hold
      // absolute angle; gyro still keeps integrating above.
      if (horizontal >= MIN_HORIZONTAL_G) {
        const raw = Math.atan2(gx, -gy);
        const delta = shortestDelta(currentRoll, raw);
        currentRoll += delta * ALPHA_G;
      }
    }

    pushRollSample(now, currentRoll);
  }

  // Use the roll from (now − IMU_DELAY_MS) so orientation matches the
  // video frame, which is delayed by the camera pipeline.
  function delayedRoll() {
    return rollAt(performance.now() - IMU_DELAY_MS);
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

  // ---------- Real-time loop ----------
  function loop() {
    if (video.readyState < 2) {
      requestAnimationFrame(loop);
      return;
    }

    const now = performance.now();
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

    pCtx.save();
    if (facingMode === "user") {
      pCtx.setTransform(-1, 0, 0, 1, vw, 0);
    } else {
      pCtx.setTransform(1, 0, 0, 1, 0, 0);
    }
    pCtx.drawImage(video, 0, 0, vw, vh);
    pCtx.restore();

    const angle = rotStep * (Math.PI / 2);
    const swapped = (rotStep % 2 === 1);
    const roll = delayedRoll();

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
