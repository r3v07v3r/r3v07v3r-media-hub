# R3 Media Hub for Android (phone and TV)

One APK for phones and Android TV / Google TV. It is the desktop app's own
service layer, run on the device, behind the simple phone/TV UI:

| Part | What it is | Where it comes from |
|---|---|---|
| Backend | `dist-headless/backend.cjs` — the desktop's `src/main`, headless | `npm run build:headless` |
| Page | `dist-app/` — the phone/TV UI | `npm run build:app` (`src/app-ui`) |
| Runtime | Node 24 built for Android (Termux's `nodejs-lts`) | `scripts/android-node-payload.mjs` |
| Shell | This Kotlin app: starts the backend, shows the page | `android/app` |

The backend runs as a child process on `127.0.0.1:47310`; the page reaches it
over the same bridge a browser would (`src/headless/bridge.ts`). Stored
credentials are sealed with a key that exists only wrapped by the Android
Keystore (`MasterKey.kt`).

## Getting a build

CI builds it: the **Android app** workflow, artifact `r3-media-hub-android`.
Nothing here builds on a PC without the Android SDK, and nothing needs to.

Install: copy the APK to the phone and tap it (allow installs from that app
when asked). Builds are signed with the committed debug key (`debug.p12`), so
each new build installs over the last and keeps the app's data.

On a Xiaomi phone `adb install` is refused without a Mi account; push the file
instead and tap it:

```
adb push r3-media-hub-android.apk /sdcard/Download/
```

## Linking to the desktop

Desktop: control centre → Media servers → **Link a phone** → Show code. Scan it
with the phone's camera; it opens this app on its pairing screen
(`r3hub://pair?…`). See `src/main/media-hub/devicePairingCore.ts`.

## Debugging

- `adb logcat -s R3Backend` — the backend's own output.
- Debug builds allow `chrome://inspect` for the page.

## Not yet

- The player (libmpv under the WebView — proven in the spike, PR #168).
- 32-bit devices (`armeabi-v7a`): needs Termux's `arm` Node staged the same way.
- Release signing.
