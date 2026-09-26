# R3 Spike — the device questions, answered on the real box

A throwaway measurement app (`com.r3v07v3r.spike`). It is **not** the TV app and
shares no code with it; it exists to turn the plan's go/no-go gates into numbers
on the actual hardware before anything expensive is built. Delete this folder,
`scripts/spike-lan-proxy.mjs` and `.github/workflows/android-spike.yml` once the
gates are decided.

What it is: a full-screen **libmpv** `SurfaceView` with a **transparent WebView**
over it and a small HUD on top — the exact compositing the TV app will use.
Every run is one `adb` command; every result goes to logcat (`R3Spike`) and the
HUD.

## Get it on the box

1. On the PC: install Android **platform-tools** (adb). On the box: Settings →
   Device preferences → About → click _Build_ 7×, then Developer options →
   **USB/Network debugging** on.
2. `adb connect <box-ip>:5555` and accept the prompt on the TV.
3. Download `r3-spike-debug` from the latest **Android spike** workflow run and
   install it. Each CI build is signed with a fresh debug key, so remove the old
   one first:

   ```bash
   adb uninstall com.r3v07v3r.spike
   ```

   ```bash
   adb install r3-spike-debug.apk
   ```

4. Watch results in a second terminal:

   ```bash
   adb logcat -s R3Spike
   ```

## The runs

`V` below is a direct **https** link to a test file. The one that matters is an
MKV with HEVC 10-bit video and **styled ASS subtitles** (any anime episode);
also worth trying: an HDR title, and a 4K one.

**S4a — does it play, and with what decoder?** The HUD shows `hwdec-current`,
codec, size, fps and the two drop counters. Look at the picture: corruption or
green frames on Amlogic/Mali with `mediacodec-copy` is a known, unfixable bug.

```bash
adb shell am start -n com.r3v07v3r.spike/.MainActivity --es video "V" --es vo gpu-next --es hwdec mediacodec
```

Repeat for the matrix — `vo`: `gpu-next`, `gpu` · `hwdec`: `mediacodec`,
`mediacodec-copy`, `no`. Note for each: plays? subtitles styled? drops after
two minutes? picture clean?

**S4b — D-pad over video.** The default page is a transparent overlay with a
navigable grid and a live key→paint meter. Drive it with the remote while the
film plays. Gate: median under ~150 ms, and the video does not stutter when
focus moves.

**S4c — mpv's own IPC socket in the sandbox.** If this says `OK`, the desktop's
mpv client (`src/main/media-hub/mpv.ts`) connects almost unchanged; if not, a
small Kotlin shim speaks the same protocol instead.

```bash
adb shell am start -n com.r3v07v3r.spike/.MainActivity --es ipc 1
```

**S3 — the real app in this box's WebView.** On the PC, start the headless
backend on a scratch profile and the LAN proxy in front of it:

```bash
npx vite build -c vite.web.config.ts
```

```bash
node scripts/build-headless.mjs
```

```bash
R3_USER_DATA="$PWD/.spike-profile" R3_SITE_DIR="$PWD/dist-web" R3_BRIDGE_PORT=5310 node dist-headless/backend.cjs
```

```bash
node scripts/spike-lan-proxy.mjs
```

Take the launch URL the backend printed, swap `http://127.0.0.1:5310` for the
LAN address the proxy printed, and open it on the box (first run walks the
welcome flow — use the remote, or `adb shell input text`). `perf 1` then runs an
automatic scroll + focus probe 12 s after load:

```bash
adb shell am start -n com.r3v07v3r.spike/.MainActivity --es url "http://<pc-ip>:5311/?launch=<code>" --es perf 1
```

Run it again with `--es lite 1` added (blur, animation and transitions off) and
compare. After the first sign-in the cookie is kept, so later runs use
`--es url "http://<pc-ip>:5311/#/movies"`. Gate: scroll p95 under ~33 ms and
focus p50 under ~150 ms, at least in `lite`.

**S7 — memory, with both halves busy.** The real app loaded _and_ a film
decoding underneath it:

```bash
adb shell am start -n com.r3v07v3r.spike/.MainActivity --es url "http://<pc-ip>:5311/#/movies" --es video "V"
```

```bash
adb shell dumpsys meminfo com.r3v07v3r.spike
```

The WebView's renderer is a separate `…:sandboxed_process` entry — add it. Gate:
comfortably under ~900 MB total, leaving room for the Node backend (spike S5),
and no low-memory kill in 30 minutes.

## What to send back

The `R3Spike` logcat from each run (it starts with the device, ABI list, RAM
and WebView version), the `dumpsys meminfo` output, and a phone photo of the
screen for anything that looks wrong.
