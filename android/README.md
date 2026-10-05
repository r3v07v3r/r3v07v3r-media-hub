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
install it (`Updater.kt`). Android always asks the person to confirm, and
only installs an update signed with the same key as the build on the phone.
Pull-request builds, and releases made before the release key below is set up,
are signed with the committed debug key (`debug.p12`), which anyone can use to
build an APK that installs over them.

## Release signing

Release builds are signed with a key that is never in the repository. The
**Android app** workflow uses it on release runs whenever the four secrets
below exist; without them it signs with the debug key as before. Its **Build
APK** step ends with a line saying which key signed the build.

1. Create the keystore (PKCS12, valid for 25 years) with `keytool`, which
   comes with any JDK (Android Studio has one in `jbr/bin`). Keep the file
   outside this repository. keytool asks for a password; with PKCS12 the key
   has the same password as the keystore.

   ```
   keytool -genkeypair -v -storetype PKCS12 -keystore r3-release-key.p12 -alias r3-release -keyalg RSA -keysize 4096 -validity 9131 -dname "CN=R3 Media Hub"
   ```

2. Encode it as base64 on one line.

   Windows (PowerShell), copied to the clipboard:

   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("$PWD\r3-release-key.p12")) | Set-Clipboard
   ```

   Linux:

   ```
   base64 -w0 r3-release-key.p12
   ```

3. On GitHub: the repository's **Settings → Secrets and variables → Actions →
   New repository secret**, one for each:

   | Secret | Value |
   |---|---|
   | `ANDROID_KEYSTORE_BASE64` | the base64 text from step 2 |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password |
   | `ANDROID_KEY_ALIAS` | `r3-release` (the `-alias` above) |
   | `ANDROID_KEY_PASSWORD` | the same password again |

   Set all four. With the keystore set but any of the other three missing,
   the release build stops rather than fall back to the debug key.

4. Keep `r3-release-key.p12` and its password somewhere safe outside GitHub,
   such as a password manager. GitHub will not show a secret again, and if the
   key or password is lost no future update can install over a released build:
   every phone would have to uninstall the app and start again.

5. The first release-signed build will not install over a debug-signed one;
   the app says so when the person taps Update. On each phone running a
   debug-signed build, uninstall R3 Media Hub once (this removes its settings,
   sign-ins and desktop link from that phone), then install
   `r3-media-hub-android.apk` from the latest release and link it again.
   Updates after that install over each other as before.

## Linking to the desktop

Desktop: control centre → Media servers → **Link a phone** → Show code. Phone:
Settings → **Scan code**. The QR code is plain text, not a link, because it
carries a decryption key and a link can be claimed by any installed app; the
app's own scanner reads it. See `src/main/media-hub/devicePairingCore.ts`.

Once linked, the phone catches up each time the app opens, comes back to the
front, or is linked: it fetches your Plan to Watch list and Simkl's watched
history from the services themselves, not from the desktop. Home then shows
Continue Watching and Plan to Watch, and a title's Play starts at the next
episode you have not watched. Shows Simkl lists as watching, and shows you
play on the phone, are added to the phone's own list. It only adds; see
`docs/WATCHLIST-SYNC.md`.

A title's page has **My List** and **Not interested** beside Play. Not
interested keeps the title out of the phone's recommendations, and offers an
Undo for a few seconds; press it again to take it back. It is kept on the
phone only, like the desktop's.

## Debugging

- `adb logcat -s R3Backend` — the backend's own output.
- Debug builds allow `chrome://inspect` for the page.

## Not yet

- Party sync, chapters, subtitle search and the other desktop player extras
  on the phone player screen: the backend supports them, the screen does not
  show them yet.
- Episodes watched on the phone reaching the desktop's own history: the catch-up
  runs from Simkl into the phone only.
- Not interested marks shared between the phone and the desktop: each keeps its
  own, and neither is sent to the tracking services.
- 32-bit devices (`armeabi-v7a`): needs Termux's `arm` Node staged the same way.
