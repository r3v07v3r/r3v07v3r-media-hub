# R3 Media Hub for Android (phone and TV)

One APK for phones and Android TV / Google TV. It is the desktop app's own
service layer, run on the device, behind the simple phone/TV UI:

| Part    | What it is                                                            | Where it comes from                                 |
| ------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| Backend | `dist-headless/backend.cjs` — the desktop's `src/main`, headless      | `npm run build:headless`                            |
| Page    | `dist-app/` — the phone/TV UI                                         | `npm run build:app` (`src/app-ui`)                  |
| Runtime | Node 24 built for Android (Termux's `nodejs-lts`)                     | `scripts/android-node-payload.mjs`                  |
| Player  | libmpv under the WebView, driven by the backend over mpv's IPC socket | `PlayerHost.kt`, `src/main/media-hub/hostPlayer.ts` |
| Shell   | This Kotlin app: starts the backend, shows the page, updates itself   | `android/app`                                       |

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

The first launch fetches the catalogue from its sources, which can take up to
a minute. Until it arrives, Home shows placeholder rows and, after a few
seconds, a line saying it is still loading. Movies, Series and Anime say
"Nothing here yet." and fill in by themselves when it lands, so there is no
need to reopen them.

## Updates

On every launch the app checks the GitHub releases for a newer APK on its
channel and offers to install it (`Updater.kt`). The phone takes its channel
from the desktop's **Control centre → Updates** when it is linked, and uses
preview until then. A later change on the desktop reaches the phone the next
time it is linked. A desktop still on its default channel is an exception;
see Known limitations.

Android always asks the person to confirm, and only installs an update signed
with the same key as the build on the phone. Pull-request builds, and releases
made before the release key below is set up, are signed with the committed
debug key (`debug.p12`), which anyone can use to build an APK that installs
over them.

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

   | Secret                      | Value                             |
   | --------------------------- | --------------------------------- |
   | `ANDROID_KEYSTORE_BASE64`   | the base64 text from step 2       |
   | `ANDROID_KEYSTORE_PASSWORD` | the keystore password             |
   | `ANDROID_KEY_ALIAS`         | `r3-release` (the `-alias` above) |
   | `ANDROID_KEY_PASSWORD`      | the same password again           |

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
Settings → **Your computer** → **Scan code**. The QR code is plain text, not a
link, because it carries a decryption key and a link can be claimed by any
installed app; the app's own scanner reads it. See
`src/main/media-hub/devicePairingCore.ts`.

Once linked, the phone catches up each time the app opens, comes back to the
front, or is linked: it fetches your Plan to Watch list and watched history
straight from Simkl, not from the desktop. Of the tracking services, a link
carries only Simkl: Trakt and MyAnimeList stay on the desktop, and the phone
has no sign-in for them, so a list kept only there does not reach the phone.
The desktop runs the same catch-up when it opens and when its window comes
back to the front, so what you watch on the phone reaches the desktop's
history through Simkl too.

## Home and your lists

The catch-up adds a show to My List when it brings in an episode you watched
somewhere else, as long as Simkl lists the show as watching and you watched
it in the last year. Watching an episode past 80% on the phone adds the show
too. The catch-up never removes a viewing, and never takes a show it added off
My List. Two kinds of title can leave My List by themselves: a film the
catch-up records as watched, and a title that came from Simkl's Plan to Watch
list and has since been taken off that list, unless it is a show you have
watched any of, even just a special. A film from that list that you watch on
the phone leaves this way once Simkl moves it to completed. A film you put on
My List on the phone stays there after you watch it, though it leaves the Plan
to Watch row. See `docs/WATCHLIST-SYNC.md`.

Home shows Continue Watching and Plan to Watch. Plan to Watch is the titles on
My List that you have not started. Watching only a special does not start a
show, so it stays under Plan to Watch; if none of its regular episodes has
aired yet, it is in neither row until the first one airs. A show you have
started whose episode list cannot be fetched at that moment is also left out
of both rows, so it is never put under Plan to Watch by mistake; it comes back
once Home refreshes and the list comes through.

Home can show these notes above its rows:

- **Could not reach the backend for recommendations.**, in orange, when Home's
  own request failed. On a first launch it can mean no catalogue source was
  reachable; see Known limitations.
- **Updating…**, while a catch-up that has run for more than a second
  finishes. On a freshly linked phone the rows fill in as that first pass goes,
  Plan to Watch first and Continue Watching once the watched history is in;
  until it is done, Home does not show its "Nothing to show yet" note.
- **Simkl signed this device out. Link your computer again in Settings.** Scan
  a new code under Settings → **Your computer** → **Scan code**. Linking hands
  the phone the desktop's own Simkl sign-in, so if the note comes back straight
  after, reconnect Simkl on the desktop first and scan again. Until then the
  phone asks Simkl again only every six hours, or after a Force stop.
- A line saying to link your computer in Settings, on a phone with no Simkl
  sign-in and nothing on its lists. Linking clears it only if the desktop
  itself is signed in to Simkl.

## A title's page

A title's page has **My List** and **Not interested** beside Play. Not
interested keeps the title out of the phone's recommendations, and offers an
Undo for a few seconds; press it again to take it back.

A series' page opens on the season you are up to, its Play naming the next
episode you have not watched (for example Play S2 · E4). Episodes you have
watched, here or anywhere Simkl knows about, carry a small green tick in the
episode list. If a catch-up lands while a show's page is open, its ticks, its
Play button and My List update in place; there is no need to leave and reopen
it.

## Playing

The player has play and pause, seeking, and the audio and subtitle tracks the
release carries. When an episode ends, the player stays on its last frame.
Press Back to return to the title's page, ready for the next one. It sends no
live scrobbles; an episode or film played past 80% is sent to Simkl as
watched.

## Debugging

- `adb logcat -s R3Backend` — the backend's own output.
- `chrome://inspect` on a PC reaches the page over USB. Every APK is the debug
  build type, the release-signed ones included (the release key only replaces
  its signing), so this works on any installed build.

## Known limitations

- The phone and TV player has none of the desktop player's extras: Skip intro,
  Skip credits and the Up next card, chapters, playback speed, Anime4K and
  subtitle search.
- Watch Party: the phone and TV app cannot host or join a party.
- Not interested marks shared between the phone and the desktop: each keeps its
  own, and neither is sent to the tracking services.
- A desktop left on its default channel shows Stable but sends no channel when
  a phone links, so the phone stays on preview. Pick Preview and then Stable on
  the desktop before linking.
- A first launch with no catalogue source reachable: Home says it could not
  reach the backend and shows no rows, not even Continue Watching or Plan to
  Watch, until a catalogue has been fetched once.
- 32-bit devices (`armeabi-v7a`): needs Termux's `arm` Node staged the same way.
