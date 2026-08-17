# HorizonLock – Progressive Web App

Real-time **IMU horizon-lock** camera stabilisation that works in the browser.  
No Xcode required. Runs on iPhone Safari (and Chrome/Android).
https://yl-loaf.github.io/horizon-lock/

The image stays level even when you spin the phone. A fixed digital zoom (overscan) prevents the FOV from constantly expanding and contracting.

## How to use on iPhone 13

### 1. Serve over HTTPS
Camera + DeviceMotion only work on a secure origin.

Easiest options:

**Option A – GitHub Pages / Netlify / Vercel (recommended)**  
Upload the whole `HorizonLockPWA` folder to any static host.  
You get a free HTTPS URL instantly.

**Option B – Local network (quick test)**  
On a computer on the same Wi-Fi:

```bash
# from the HorizonLockPWA folder
npx serve -s . --ssl-cert <your-cert>   # or use a tool that gives HTTPS
# or simply:
python3 -m http.server 8080
```
Then open `https://<your-computer-ip>:8080` on the iPhone (self-signed cert warning is OK for testing).

**Option C – Cloudflare Tunnel / ngrok**  
Expose a local folder with HTTPS in one command.

### 2. Open on iPhone
1. Open the HTTPS URL in **Safari**.
2. Tap **Enable Camera & Motion**.
3. Accept the camera and motion permission prompts.
4. (Optional but recommended) Tap the Share button → **Add to Home Screen**.  
   The app then launches full-screen like a native app.

### 3. Controls
- Slider = digital zoom / overscan amount (1.3×–2.4×). Higher = more margin when spinning.
- Big button = start / stop recording. Video downloads automatically when you stop.
- Top-left button = switch front / rear camera.

## Technical notes

| Feature              | Implementation                          | iOS Safari notes                          |
|----------------------|-----------------------------------------|-------------------------------------------|
| Camera               | `getUserMedia`                          | Works, resolution limited by browser      |
| IMU / Horizon lock   | `DeviceMotionEvent` (gravity)           | Requires user gesture + permission        |
| Frame processing     | Canvas 2D (rotate + scale + crop)       | 30 fps achievable at 1080p on iPhone 13   |
| Recording            | `canvas.captureStream` + MediaRecorder  | WebM or MP4 depending on browser          |
| Installable          | Web App Manifest + Service Worker       | “Add to Home Screen”                      |

### Limitations vs native app
- Sampling rate of the browser IMU is lower than CoreMotion (~60 Hz max).
- No access to Apple’s high-quality cinematic stabilisation pipeline.
- Performance is good for normal–aggressive use; extremely high spin rates may show more lag than the native version.
- Recording format is WebM (Chrome) or MP4 (Safari) – both play fine on iPhone.

### Files
```
HorizonLockPWA/
├── index.html
├── style.css
├── app.js          ← all the logic
├── manifest.json
├── sw.js           ← service worker
└── README.md
```

Simple icons (`icon-192.png`, `icon-512.png`) can be added later if you want a nicer home-screen icon. The app works without them.

Enjoy spinning your iPhone while the horizon stays locked!
