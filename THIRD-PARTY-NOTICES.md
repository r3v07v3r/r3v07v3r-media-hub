# Third-party notices

R3 Media Hub's own source code is released under the [MIT License](LICENSE). The builds it
produces also carry, fetch or link software written by other people, which stays under its own
license. This file lists those components and where their source and license text live. The npm
packages the app is built from each carry their license inside the package.

## Shipped with the Windows installer

| Component                   | What it is here                                                                                                                                                                             | License                                                                                                     | Source                                                                       |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| mpv                         | The player, shipped as a separate program (`resources/mpv/mpv.exe`) that the app starts and controls. Fetched at install time by `scripts/fetch-mpv.ts`, pinned by release tag and SHA-256. | GPL-2.0-or-later, and includes FFmpeg and other libraries under their own licenses                          | <https://mpv.io>, built by <https://github.com/shinchiro/mpv-winbuild-cmake> |
| Electron, Chromium, Node.js | The application runtime                                                                                                                                                                     | MIT, BSD-3-Clause and others; see the `LICENSE` and `LICENSES.chromium.html` files beside the installed app | <https://github.com/electron/electron>                                       |
| Inter, Orbitron, Rajdhani   | Interface fonts, from the `@fontsource` packages                                                                                                                                            | SIL Open Font License 1.1                                                                                   | <https://fontsource.org>                                                     |

## Fetched on request

| Component | What it is here                                                                 | License | Source                              |
| --------- | ------------------------------------------------------------------------------- | ------- | ----------------------------------- |
| Anime4K   | GLSL shaders, downloaded only when you install the pack from the control centre | MIT     | <https://github.com/bloc97/Anime4K> |

## Shipped with the Android app

| Component                                    | What it is here                                                     | License                                                 | Source                                                                      |
| -------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------- |
| libmpv with FFmpeg (`dev.jdtech.mpv:libmpv`) | The player library the app loads                                    | The licenses of mpv and FFmpeg as built in that package | <https://github.com/jarnedemeulemeester/libmpv-android>                     |
| Node.js for Android                          | The runtime the backend runs on, from Termux's `nodejs-lts` package | MIT, with bundled libraries under their own licenses    | <https://github.com/termux/termux-packages>                                 |
| Google Play services code scanner            | Reads the pairing code                                              | Google's terms for Play services                        | <https://developers.google.com/ml-kit/vision/barcode-scanning/code-scanner> |

## Services, not software

The catalog, artwork and tracking data come from services the app talks to (Cinemeta, Kitsu,
AniList, Simkl, Trakt, MyAnimeList, TMDB, OMDb, Aniskip, SubDL, OpenSubtitles, TorBox). Their data
and names belong to them and are used under their own terms; nothing of theirs is redistributed in
this repository.
