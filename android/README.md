# R3 Media Hub for Android (phone and TV)

One APK for phones and Android TV / Google TV. It is the desktop app's own
service layer, run on the device, behind the simple phone/TV UI:

| Part | What it is | Where it comes from |
|---|---|---|
| Backend | `dist-headless/backend.cjs` — the desktop's `src/main`, headless | `npm run build:headless` |
| Page | `dist-app/` — the phone/TV UI | `npm run build:app` (`src/app-ui`) |
| Runtime | Node 24 built for Android (Termux's `nodejs-lts`) | `scripts/android-node-payload.mjs` |
| Player | libmpv under the WebView, driven by the backend over mpv's IPC socket | `PlayerHost.kt`, `src/main/media-hub/hostPlayer.ts` |
| Shell | This Kotlin app: starts the backend, shows the page, updates itself | `android/app` |

The backend runs as a child process on `127.0.0.1:47310`; the page reaches it
over the same bridge a browser would (`src/headless/bridge.ts`). Stored
credentials are sealed with a key that exists only wrapped by the Android
Keystore (`MasterKey.kt`).

## Getting a build

Every desktop release (preview and stable) carries `r3-media-hub-android.apk`,
built at that release's version. PR builds come from the **Android app**
workflow, artifact `r3-media-hub-android`.

Install: copy the APK to the phone and tap it (allow installs from that app
when asked). On a Xiaomi phone `adb install` is refused without a Mi account;
push the file instead and tap it:

```
adb push r3-media-hub-android.apk /sdcard/Download/
```

## Updates

On every launch the app checks the GitHub releases for a newer APK on its
channel (preview until linked to a desktop that says stable) and offers to
install it (`Updater.kt`). Android always asks the person to confirm. Builds
are signed with the committed debug key (`debug.p12`), so updates install
over each other and keep the app's data. **Before the app goes beyond test
phones, switch to a release key kept out of the repository** — anyone holding
the debug key can build an APK that installs over this one.

## Linking to the desktop

Desktop: control centre → Media servers → **Link a phone** → Show code. Phone:
Settings → **Scan code**. The QR code is plain text, not a link, because it
carries a decryption key and a link can be claimed by any installed app; the
app's own scanner reads it. See `src/main/media-hub/devicePairingCore.ts`.

## Debugging

- `adb logcat -s R3Backend` — the backend's own output.
- Debug builds allow `chrome://inspect` for the page.

## Not yet

- Party sync, chapters, subtitle search and the other desktop player extras
  on the phone player screen: the backend supports them, the screen does not
  show them yet.
- 32-bit devices (`armeabi-v7a`): needs Termux's `arm` Node staged the same way.
- Release signing.
