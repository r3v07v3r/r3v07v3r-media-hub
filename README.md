<div align="center">
  <img src="build/icon.png" alt="R3 Media Hub logo" width="112" />

# R3 Media Hub

**A desktop home for browsing, tracking, and playing movies, series, and anime.**

[![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

R3 Media Hub is an Electron application that brings discovery, watch history, playback, and
watching together into one interface. Browse the catalog without an account, then connect either
TorBox or your own Jellyfin server when you are ready to play something. Everything else — metadata,
tracking accounts, subtitle services, a LAN cache server, a relay for watching together, a local AI
model — is optional and adds to the experience without being required.

> [!IMPORTANT]
> R3 Media Hub does not provide media, a TorBox subscription, or a media server. You are
> responsible for the services and libraries you connect and for ensuring that your use of media
> complies with applicable law.

This README is written from the code, not from memory. Every feature below says what it needs, and
the [feature chain](#the-feature-chain) explains how the pieces depend on each other. A companion
[audit report](docs/AUDIT-2026-09-27.md) records how it was checked and what is still open.

## At a glance

```text
 Discover               Choose a source            Play                    Keep track
 ┌──────────────────┐   ┌──────────────────────┐   ┌────────────────────┐  ┌───────────────────────┐
 │ Movies / Series  │   │ 1 this machine's own │   │ mpv, embedded      │  │ status, ratings, lists│
 │ Anime / For You  │──▶│   cache              │──▶│ subtitles, skip    │─▶│ history, stats        │
 │ search, moods,   │   │ 2 r3-cache on the LAN│   │ intro, next episode│  │ Simkl / Trakt / MAL   │
 │ calendar         │   │ 3 Jellyfin  4 TorBox │   │ Anime4K            │  │ backup and imports    │
 └──────────────────┘   └──────────────────────┘   └────────────────────┘  └───────────────────────┘
          needs nothing       needs TorBox or Jellyfin      needs mpv (bundled)     needs nothing
                                                                  │
                                         Watch Party (direct or relayed) · Rooms (relay) · Profiles
```

## The feature chain

Each stage lists what it **needs**. "Needs nothing" means no account, no key, no extra software.

### 1. Discover — needs nothing

The catalog is public data: movies and series come from Cinemeta merged with Simkl's public
trending feed (either one alone fills the grid), anime from Kitsu. No key is required.

- **Browse movies, series, and anime** with search, a trailer on the title page, seasons and
  episodes, ratings, similar titles, and recommendations. Filter by genre, year and minimum
  rating, plus runtime for movies, number of seasons and episode length for series, episode count
  for anime, and status. Hide what you have started or watched, shows you are caught up on, and
  titles you marked **Not interested** (they collect under My Stuff → Not for me), in any
  combination, and choose which of those start switched on
  from the Settings page's Browsing card. Save any filter combination as a named view; it comes back as
  a chip. **Scan deeper** on a category page pulls in more of the catalog than loaded by itself.
- **Recommendations that say why.** Home shows the top row; **For You** shows the whole ranking,
  shelved by reason: a franchise continuation, a director or actor who recurs in what you have watched, a genre
  match. After
  a film or anime, the next part of its series is offered first, and a rewatch counts. Your own
  ratings steer it: a genre you watch often but enjoy little stops leading. An anime whose
  seasons are merged into one show is suggested as that show, never as one of its later seasons.
- **Cast and crew are clickable** once a TMDB key is connected: names open what else of theirs
  the catalog holds, and typing a director's name in search finds their films rather than films
  with their name in the title.
- **Moods.** A Browse-by-mood tray on Home, and a full mood page.
- **Calendar.** Its own page: episodes of what you follow, a week back and six weeks ahead. Unaired
  anime episodes show their air date or TBA on the title page and cannot be played early.
- **With a TMDB key** (optional): the age certificate for your region, cast and crew,
  the rest of a film's collection, better similar-title lists, and per-season episode data for
  grouped anime. **With an OMDb key**: the Rotten Tomatoes score.
- **Anime franchises in story order.** An anime's page lays out its franchise (prequels, the main
  or full story, side stories, spin-offs, recaps, sequels) from Kitsu, with no key needed. A show
  merged from several seasons is treated as one title: what comes before it is what precedes its
  first season, what comes after is what follows its last, and its own seasons are not listed.

### 2. Choose a source — needs TorBox or a Jellyfin server

A title that is already complete in this machine's cache, or held by a paired r3-cache server,
plays with nothing else connected. Everything else needs **TorBox** or an enabled **Jellyfin**
server; without either, pressing Play says the title is not on this computer or a paired cache
server and asks you to connect one. Sonarr, Radarr,
qBittorrent, Prowlarr and Bazarr are management and status connections, not playback sources: what
they fetch becomes playable once it reaches your Jellyfin library.

When you press **Play**, the app stops at the first of these that has a copy within your quality
limits:

1. **This machine's own cache** — a stream already on disk from an earlier play, checked against
   your resolution limit only. A partial download is resumed from the source it originally came
   from rather than restarted.
2. **A paired [r3-cache](daemon/README.md) server on your LAN**, when it holds the title complete.
   A server that has not answered within 3 seconds is treated as away, and the app moves on.
3. **Your Jellyfin server.** On **Media server** a copy within your limits plays straight away and
   TorBox is never asked. On **Balanced**, the default, it also plays straight away unless a copy
   more than twice as sharp could exist within your limits: a 1080p copy always plays, a 720p copy
   under a 4K limit makes the app ask TorBox and compare the two. The server copy still wins ties.
   On **Best quality** the two always compete. With no TorBox connected, the server copy plays on
   every setting.
4. **TorBox.** The stream that played last time is checked first. Otherwise the Torrentio and Comet
   add-ons are searched for releases, TorBox is asked which of them it already has, and the
   candidates are scored on whether they are the right title, whether they can play right now, their
   resolution and their audio language, with a nudge toward the release group that played the
   previous episode. If nothing is cached, the best release is submitted to TorBox and you are told to try
   again in a few minutes.

**Control centre → Playback → Network** holds the knobs: **Where to play from** (Media server,
Balanced, Best quality), the maximum video quality and download size that every remote tier must
meet, and a **Connection recommendation** test that suggests both. If the best copy is noticeably
below your ceiling, the app asks once per title per session whether to play it anyway.

**Storage while playing.** On first run the app asks whether video may be cached to disk. **Keep
media on this device** off means memory-only streaming; on, you choose the cache size and folder
under **Control centre → Playback → Storage while playing**. Both answers are reversible.

### 3. Play — needs mpv (bundled with the Windows installer)

Playback is mpv, embedded inside the app's own window on Windows; there is no transcoding.

- **Controls:** speed from 0.5× to 2×, chapter navigation, audio and subtitle sync offsets,
  subtitle size, position, colour and backdrop, a night mode that evens out quiet dialogue against
  a loud score, seek-bar thumbnail previews, and a sleep timer that can stop at the end of the
  episode. Frame step, an A-B loop and a screenshot button sit in the Playback menu.
- **Keys:** <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> seek, <kbd>↑</kbd>/<kbd>↓</kbd>
  volume, <kbd>PageUp</kbd>/<kbd>PageDown</kbd> chapters, <kbd>f</kbd> fullscreen, <kbd>.</kbd> and
  <kbd>,</kbd> frame step, <kbd>s</kbd> screenshot, <kbd>i</kbd> stream info, <kbd>a</kbd> Anime4K
  on or off, <kbd>Esc</kbd> leave fullscreen, or close the player.
- **Skip the intro and the credits.** Anime uses Aniskip's community-submitted times; movies and
  series read the release's own chapter marks, so a mislabeled chapter is never trusted.
- **Keep watching a series.** When an episode ends, the next one is offered on a post-play card and
  starts after a short countdown. If a stream stops well short of its runtime, a card says so and
  offers Resume or Stop instead of marking the title watched. Turn it off with **Play the next episode** on the Settings page.
  Play on a series card starts the next episode you have not watched, not the first.
- **Subtitles** come from the release's embedded tracks, or are searched automatically when SubDL
  or OpenSubtitles is connected. Both are searched together; SubDL rows come first because its
  downloads are unmetered, and OpenSubtitles can match by file hash for frame-accurate sync.
- **Anime4K** (optional): install the shader pack once from **Control centre → General →
  Performance & Display**, then toggle it live with the player's button or <kbd>a</kbd>, and pick a
  mode. The same card holds **Video scaling** (Standard, High or Sharp), the **Playback buffer** preset,
  and the switch for Home's live CPU, GPU, RAM and network gauges.
- **Unsafe files are kept out.** A release whose name advertises an executable is never chosen or
  submitted to TorBox, and any file the app's web content tries to save to disk is refused if its
  type is on the blocklist, with a warning that names the file, where it came from, and the reason.

### 4. Keep track — needs nothing

- **One status per title:** not watched, planned, or watched. A pill on a title's page, in the
  library side panel and on the Home hero cycles through the three; the right-click menu offers
  **Plan to watch** and **Mark watched** (**Mark all watched** on a series) as separate items. Marking a whole series watched marks
  every aired episode, and clearing it offers an undo. On the episode list, **Mark season watched**
  acts on a season's aired episodes, and <kbd>Ctrl</kbd>- or <kbd>Shift</kbd>-clicking episodes
  selects several to mark at once. Lists are separate from status.
- **Rate what you have seen** out of 10 on a title's page. Each profile keeps its own scores, and
  they steer recommendations. If Trakt is connected, scores are also sent to that account.
- **My Stuff** has eight tabs: **Planned** (filterable by kind and by the service it came from,
  with anything not out yet pulled to the top), **In progress**, **Watched**, **Lists** (your named
  lists, plus any lists on a connected Trakt or Simkl account, read-only), **Rated**, **History**
  (the 500 most recent viewings; any single viewing can be removed without un-watching the
  episode), **Stats**, and **Not for me**.
- **Profiles**, including PIN-protected ones. Each keeps its own list, history, ratings and resume
  points. A profile can be marked **Kids**, which today only shows a badge next to its name; it does
  not yet restrict what that profile can browse or play.
- **Hear about new episodes** of anything you follow, as a desktop notification. Off until you turn
  it on under **Control centre → General**, checked a few times a day, never while you are watching.

### 5. Sync — optional, one account per service

Each tracking service needs its own API application: create one on the service's developer site and
enter the Client ID (and, for Trakt, the client secret; MyAnimeList's is optional) under
**Control centre → Accounts**.

| Service         | What it does                                                                                                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Simkl**       | Pushes watch history and live scrobbles; syncs the plan-to-watch list both ways; shows your Simkl lists. When a movie's watched state differs between this app and Simkl, an **Out of sync with Simkl** panel lets you pick which side is right. |
| **Trakt**       | Pushes watch history, ratings and live scrobbles for movies and series (anime is not sent); reads your watchlist and lists; imports an existing account's history and ratings once, safely repeatable.                                           |
| **MyAnimeList** | Pushes anime progress and syncs the plan-to-watch list; **Preview sync with MAL** shows what would change before you apply it.                                                                                                                   |

**Keep watchlists in sync** (under Accounts → Tracking) is the two-way rule: planning or un-planning
here pushes out, and a title a service drops is removed here too, but only if this app pulled it in
from that service originally. The rules are written down in [docs/WATCHLIST-SYNC.md](docs/WATCHLIST-SYNC.md).

> Known limitation: a mark made while a service is unreachable is logged and dropped, not retried.
> Only the Simkl movie comparison above catches the difference later.

- **Bring an existing history in** from **Control centre → General → Your library**: IMDb's ratings
  export (needs nothing) and a Letterboxd "Export Your Data" zip (needs TMDB connected, to match
  titles). A connected Trakt account imports from **Accounts**. Viewings keep the dates you watched
  them; imported ratings keep the score but not the date. All three only fill in what is missing.
- **Back up your library** to a single file and restore it on another machine, from the same card.
  Service credentials stay on the machine that holds them.

### 6. Together — Watch Party needs nothing on a LAN; Rooms need a relay

Two different things, deliberately:

- **A Watch Party** is a temporary group watching one title in sync. Open **Rooms** in the top bar
  (it reads **Party** while one is live) and **Start a Watch Party**. Hosting always listens on your
  network directly and tries to map a router port; if an [R3 Party Sync](party-sync-worker/README.md)
  relay is connected it attaches to that too, and the single invite carries every route. Guests
  chat, suggest titles and vote on a shared queue; play, pause and seek are synchronized. By
  default only the host controls playback; **Everyone can control playback** hands that to guests.
  Each guest plays the title from their own sources, so everyone needs TorBox or Jellyfin.
- **A Room** is a standing group: the family, the film friends. Creating one needs the relay;
  joining with someone's room code does not. You see who is around and, per room and only if you
  turn on **Share what I'm watching here**, what they are watching. Then choose, each time, whether
  to **Join them** or start the same title on your own. The creator is the room's admin and can
  rename it or remove members. Nobody hosts a room, so it survives anyone going offline.
- Every party and room message is encrypted end to end before it leaves the device; the relay
  forwards ciphertext. With a paired r3-cache on the LAN, the household shares one relay connection
  per room instead of one per device.

### 7. Operate — the control centre

The gear icon in the top bar (and the **Control centre** button on the Settings page) flips the app
over to its second face. It is where the installation is configured and watched:

| Section           | What is there                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pipeline**      | How a title gets from you asking for it to it playing, with every service drawn where it sits and whether it is live.                                                                                                                                        |
| **Services**      | What each connected service is doing now: qBittorrent's torrents (pause, resume, remove and keep the files, or delete with files), the Sonarr and Radarr queues, how many Prowlarr indexers are failing, Bazarr's status, and the app's own background work. |
| **Caching**       | The r3-cache server: find it, ask to join, claim it as administrator, approve devices and set their allocations, see what it holds, and what you have cached with a private/shared switch per title. Also what this device has cached.                       |
| **Updates**       | The build you are on, the **Stable** or **Preview** channel, a download progress bar, and what the offered version changes.                                                                                                                                  |
| **General**       | Display preferences, notifications, Performance & Display (Anime4K, video scaling, buffer, gauges), Your library (backup, imports).                                                                                                                          |
| **Playback**      | Episodes, subtitles and languages, Network (limits, Where to play from, speed test), Storage while playing.                                                                                                                                                  |
| **Media servers** | TorBox (connect with its API token), and Jellyfin, Sonarr, Radarr, qBittorrent, Prowlarr and Bazarr, each with a connection test.                                                                                                                            |
| **Accounts**      | Tracking (Simkl, Trakt, MyAnimeList), Artwork & metadata (TMDB, OMDb), Subtitles (SubDL, OpenSubtitles).                                                                                                                                                     |
| **AI**            | The local Ollama model behind the assistant and Recommend Next.                                                                                                                                                                                              |
| **Community**     | The Watch Party relay, and profiles.                                                                                                                                                                                                                         |

- **Ask Sonarr or Radarr for a title** straight from its page, picking the quality profile and
  folder, with a search starting as soon as it is added. Movies and series only; anime is
  catalogued by Kitsu id, which neither service can look up.
- **Search and ask in one field.** Press Enter in the top bar and it searches the movie, series and
  anime catalogs together and shows real titles you can open. With a local model connected its
  answer appears underneath: what the top result is, whether it fits what you have watched, and
  other titles worth trying. On a category page the same field filters that page instead.
- **Run the AI locally.** The assistant and the Recommend Next buttons use an
  [Ollama](https://ollama.com) model on your own machine; nothing is sent to a hosted service. An
  Ollama at its usual `http://127.0.0.1:11434` is found on its own. Without one the search still
  answers, the assistant says plainly that no model is connected, and Recommend Next falls back to a
  pick it labels as random.
- **Stay updated on your own terms.** Packaged builds check GitHub Releases a few times a day; an
  update downloads in the background and installs when you restart.
- **Link a phone.** **Control centre → Media servers → Link a phone** shows a one-time QR code. The
  phone app scans it and is signed in to the same services: TorBox, Simkl, the TMDB, OMDb and
  SubDL keys, the OpenSubtitles login and your language preferences. Trakt, MyAnimeList, the
  r3-cache device token and your room identity stay on the desktop. The code carries a one-time
  ticket rather than the secrets, is served once, and stops after three minutes.
  Once linked, the phone's Home shows Continue Watching and a Plan to Watch row. They come from
  your Simkl account, fetched by the phone each time the app opens or comes back to the front,
  not read from the desktop. Shows Simkl lists as watching, and shows you play on the phone, are
  added to the phone's own list.

## Quick start

### Install a release

Download the Windows installer (NSIS setup executable) from the
[GitHub Releases page](https://github.com/r3v07v3r/r3v07v3r-media-hub/releases). Every push to
`preview` publishes a **Preview** build; promoting one to **Stable** is a manual step, and the
channel is yours to pick under **Control centre → Updates**.

The installer is per-machine, so Windows asks for elevation, and the install folder is fixed. The
app keeps its settings, database (`media-hub.sqlite`) and log (`logs/media-hub.log`) under
`%APPDATA%\r3v07v3r-media-hub`; include that log in a bug report.

Every release also carries `r3-media-hub-android.apk`, one build for phones and Android TV. It
is signed with a debug key until a release key is added to the repository secrets, so treat it as
a build for test devices until then; see
[android/README.md](android/README.md).

macOS and Linux packages are configured in `electron-builder.yml` but are not published: the release
workflow builds Windows only, and the bundled mpv player is fetched for Windows only. Building for
another platform from source needs an mpv you supply through `MPV_PATH`, and macOS also needs Apple
signing credentials because notarization is switched on.

### First run

A fresh install walks through a short welcome: your name (it is also what Rooms and Watch Parties
show to others), a playback source (**Connect TorBox**, **Connect a media server**, or **Not right
now**), whether video may be cached to disk, and, if so, a quick network and disk check that suggests
a quality cap, a size cap and a cache size. Everything it sets is changeable later.

1. If you skipped the source step, open the control centre (gear icon), choose **Media servers**,
   and connect **TorBox** (paste the API token from your TorBox account) or **Jellyfin** (switch the
   card on, enter the server URL and API key, then **Test connection** and **Save changes**).
2. Optional: under **Control centre → Playback**, choose your preferred audio and subtitle
   languages and connect a subtitle service under **Accounts**.
3. Open **Movies**, **Series**, or **Anime**, select a title, and press **Play**. It reads
   **Resume** once you have started, and for a show it names the next episode (for example
   **Play S1 E1**). To watch a different episode, pick it from the episode list on the title page.
4. R3 Media Hub remembers playback progress, so you can continue from Home or My Stuff.

```text
Control centre → Connect TorBox OR Jellyfin
                       ↓
Movies / Series / Anime / For You → Title page → Play → own cache → r3-cache → Jellyfin → TorBox
                       ↓                                     ↓
                    My Stuff                          Continue Watching
```

## Using the app

| Destination  | What you will find there                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Home**     | Featured picks, continue watching, one row of recommendations with their reasons, the mood tray, and optional system-performance gauges.                                                     |
| **For You**  | The full recommendation ranking, shelved by why each title was picked.                                                                                                                       |
| **Movies**   | Movie discovery and filtering. Select a card for its synopsis, ratings, related titles, and playback actions.                                                                                |
| **Series**   | TV discovery plus season and episode selection.                                                                                                                                              |
| **Anime**    | Anime discovery, franchise groupings, episode progress, and anime-specific tracking.                                                                                                         |
| **My Stuff** | Eight tabs: Planned, In progress, Watched, Lists, Rated, History, Stats, Not for me.                                                                                                         |
| **Calendar** | Episodes airing for what you follow: is there anything on tonight?                                                                                                                           |
| **Settings** | The few things you change while watching: next-episode autoplay, automatic subtitles, subtitle and audio language, browsing defaults, About & Updates, and a button into the control centre. |

The old **Downloads** page is gone; its contents live in the control centre's **Services** and
**Caching** sections, and old links land on Home. On desktop, press <kbd>Ctrl</kbd>+<kbd>B</kbd> (or
<kbd>⌘</kbd>+<kbd>B</kbd> on macOS) to collapse or expand the sidebar. On narrow windows, primary
navigation moves to the bottom; use **More** for For You, Calendar and Settings.

### Every service, and whether you need it

Playing anything that is not already cached requires **TorBox** or **Jellyfin**. Everything else
is optional. All of these are set up in
the control centre; API credentials are entered in the app, never in the source tree.

| Service             | Required?                       | What it adds                                                                                                                               | Where                              |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- |
| **TorBox**          | One of the two play sources     | Streams any title TorBox has cached; submits the best release when it has not.                                                             | Media servers, or the welcome flow |
| **Jellyfin**        | One of the two play sources     | Plays from your own library over the LAN, ranked against TorBox by **Where to play from**.                                                 | Media servers, or the welcome flow |
| **r3-cache**        | No                              | Pre-fetches what you plan to watch onto a LAN box and serves it in one hop. See [daemon/README.md](daemon/README.md).                      | Caching                            |
| **Sonarr / Radarr** | No                              | Request a series or film from its page; see their queues.                                                                                  | Media servers                      |
| **qBittorrent**     | No                              | See, pause, resume or remove torrents, keeping or deleting their files. Not a playback source.                                             | Media servers                      |
| **Prowlarr**        | No                              | A count of indexers in a failure backoff. Does not feed discovery.                                                                         | Media servers                      |
| **Bazarr**          | No                              | Connection status only.                                                                                                                    | Media servers                      |
| **TMDB**            | No (Letterboxd import needs it) | Age certificates, cast and crew, collections, better similar titles, grouped-anime episodes.                                               | Accounts → Artwork & metadata      |
| **OMDb**            | No                              | Rotten Tomatoes scores.                                                                                                                    | Accounts → Artwork & metadata      |
| **Simkl**           | No                              | History and scrobble push, two-way watchlist, your Simkl lists, the movie discrepancy review.                                              | Accounts → Tracking                |
| **Trakt**           | No                              | History, ratings and scrobble push; watchlist and lists pull; one-off import.                                                              | Accounts → Tracking                |
| **MyAnimeList**     | No                              | Anime progress push, two-way watchlist, preview-then-apply sync.                                                                           | Accounts → Tracking                |
| **SubDL**           | No                              | Subtitle search with no daily limit.                                                                                                       | Accounts → Subtitles               |
| **OpenSubtitles**   | No                              | A second subtitle catalogue with hash matching (a free account allows 5 downloads a day).                                                  | Accounts → Subtitles               |
| **R3 Party Sync**   | For Rooms; not for a LAN party  | Relays Watch Party traffic across the internet; the backbone Rooms run on. See [party-sync-worker/README.md](party-sync-worker/README.md). | Community → Watch Party relay      |
| **Ollama**          | No                              | The assistant and Recommend Next, on a model you host. Found automatically on this machine.                                                | AI                                 |

Used automatically, with nothing to configure: Cinemeta, Kitsu and Simkl's public trending feed for
the catalog; AniList for anime franchises and air dates; Aniskip for anime skip times; the Torrentio
and Comet add-ons for release discovery; GitHub Releases for updates and the Anime4K pack; router
UPnP/NAT-PMP when hosting a party.

## Run from source

### Requirements

- [Node.js](https://nodejs.org/) 22.13 or newer. The database uses Node's built-in `node:sqlite`,
  which needs no flag from 22.13 on; CI runs on Node 22.
- npm (included with Node.js) and Git.
- Windows, for playback: `npm install` downloads the mpv player (a 32 MB archive, about 114 MB unpacked) in its
  `postinstall` step for Windows only. On other platforms set `MPV_PATH` to an installed mpv.

```bash
git clone https://github.com/r3v07v3r/r3v07v3r-media-hub.git
cd r3v07v3r-media-hub
npm install
npm run dev
```

### Environment variables

The desktop app reads one: `MPV_PATH`, the path to an mpv binary, which is also the only way to
get a player on macOS or Linux when running from source. The headless backend is configured
entirely by environment: `R3_USER_DATA` (settings, database and logs; required), `R3_SITE_DIR`
(the `build:web` output to serve; required), `R3_BRIDGE_PORT` (loopback port; the OS picks one
if unset), `R3_MASTER_KEY` (32 bytes, base64, sealing stored credentials), `R3_LOCALE`,
`R3_APP_VERSION`, and `R3_STOP_ON_STDIN_CLOSE=1` for a host that owns the process. The daemon's
variables are in [daemon/README.md](daemon/README.md).

### Project commands

| Command                    | Purpose                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`              | Start Electron with the Vite development server and hot reload.                                                                 |
| `npm start`                | Preview an already-built application.                                                                                           |
| `npm test`                 | Run every registered test file (89 today, plain `tsx` scripts chained in `package.json`).                                       |
| `npm run lint`             | Check JavaScript and TypeScript with ESLint.                                                                                    |
| `npm run typecheck`        | Type-check the Electron/Node and renderer projects. The daemon is a third project, checked separately.                          |
| `npm run typecheck:daemon` | Type-check the r3-cache daemon (`daemon/`, `src/shared/`, `src/main/media-hub/`).                                               |
| `npm run build`            | Type-check, then produce the Electron application bundles.                                                                      |
| `npm run build:win`        | Build, then create the Windows installer.                                                                                       |
| `npm run build:mac`        | Create a macOS package (bundles only; run `npm run typecheck` yourself first).                                                  |
| `npm run build:linux`      | Create Linux AppImage, Snap, and Debian packages (bundles only; run `npm run typecheck` yourself first).                        |
| `npm run build:unpack`     | Build, then produce an unpacked directory instead of an installer.                                                              |
| `npm run build:web`        | Build the renderer as a plain static site with no Electron, the front end a headless backend serves.                            |
| `npm run build:headless`   | Bundle the service layer to run under plain Node with no Electron (`dist-headless/backend.cjs`).                                |
| `npm run build:app`        | Build the small phone and TV interface (`src/app-ui`) as a static site, `dist-app/`.                                            |
| `npm run build:daemon`     | Build the r3-cache daemon bundle. `build:daemon:sea` adds self-contained executables. See [daemon/README.md](daemon/README.md). |
| `npm run release-notes`    | Regenerate the About-card and release changelog text from recent commit subjects.                                               |
| `npm run format`           | Run Prettier over the tree.                                                                                                     |

The `ai:*` scripts belong to an experimental review loop described in [.ai/README.md](.ai/README.md);
it has never been run in this repository.

### Architecture

```text
src/
├── main/                 Electron main process
│   ├── index.ts          Windows, the app protocol, the updater; calls backend.ts
│   ├── backend.ts        The service layer's startup and teardown, shared with headless/
│   ├── ipc/              Validated IPC endpoints (settings, HTTP proxy, telemetry, media hub)
│   └── media-hub/        Catalog, playback, stream cache, services, tracking, parties, rooms
├── preload/              Narrow renderer-to-main bridge (window.api)
├── renderer/             React user interface; src/web/ is the entry used outside Electron
├── app-ui/               The small phone and TV interface: its own React tree, not the renderer
├── headless/             The same service layer with no Electron: an `electron` stand-in and a
│                         loopback WebSocket bridge that serves the build:web site
└── shared/               Types and logic shared across process boundaries, incl. the bridge and
                          r3-cache wire protocols
daemon/                   r3-cache, the LAN pre-fetch server (its own Node bundle)
android/                  The Android shell: runs the headless backend and app-ui on the device
party-sync-worker/        R3 Party Sync, the Cloudflare Worker relay
tests/, daemon/tests/     Plain tsx test scripts; two Playwright end-to-end tests for the web bundle

React renderer ──validated IPC (preload)──▶ Electron main ──HTTP(S) / WebSocket──▶ services
React renderer ──WebSocket bridge──────────▶ headless backend ─────────────────────▶ services
       ▲                                          │
       └────────── local playback (mpv) ◀─────────┘
```

The renderer does not receive direct Node.js access. Service calls, credential storage, the stream
cache, and party networking run in the main process and are exposed through the preload bridge. On
Windows the video is not drawn by Chromium: mpv runs as a native child window embedded in the app's
own window, kept sized and stacked over the interface, with the player controls in a transparent
overlay window. Credentials live in two stores on purpose: Jellyfin and the download stack in the
app's settings store, everything else in the media-hub settings file; both are encrypted with
Electron's `safeStorage`.

Four optional companions ship from this repository. [`daemon/`](daemon/README.md) is the r3-cache
LAN pre-fetch server. [`party-sync-worker/`](party-sync-worker/README.md) is the Watch Party relay
you deploy yourself. `src/headless/` with `npm run build:web` is the same app built to run without
Electron; playback in that build needs an mpv it can find: `MPV_PATH`, the copy `npm install`
fetches into `resources/mpv-win` on Windows, or a standard Windows install.
[`android/`](android/README.md) is one APK for phones and Android TV: the headless backend run on
the device behind a small separate interface (`src/app-ui`, `npm run build:app`), with libmpv as
the player. Party sync, chapters and subtitle search are not on its player screen yet. Its Home
catches up with Simkl's watched history (see [docs/WATCHLIST-SYNC.md](docs/WATCHLIST-SYNC.md));
episodes watched on the phone are not yet taken into the desktop.

### What CI checks

`.github/workflows/verify.yml` runs on every pull request and gates every release: lint, `npm run
build` (both typechecks plus the bundle), `npm run typecheck:daemon`, `npm test`, a production
dependency audit, the web bundle booted with no backend under the real CSP, the headless backend
built and driven end to end in a browser, and the relay typechecked and dry-run deployed. A
separate workflow builds the Android APK for any pull request that touches `src/` or `android/`. Run the
same set before opening a pull request:

```bash
npm run lint
npm run build
npm run typecheck:daemon
npm test
```

## Troubleshooting

<details>
<summary><strong>The catalog opens, but a title will not play</strong></summary>

Confirm that TorBox or Jellyfin is connected: open the control centre, **Media servers**, and check
that the TorBox card says **Connected** (reconnect if the token was revoked; a rejected token
disconnects it and tells you) or that the Jellyfin card is switched on and its **Test connection** succeeds. Sonarr, Radarr and
qBittorrent are not playback sources.

If a title plays but not from where you expected, check **Control centre → Playback → Where to play
from** and the quality limits beside it. A TorBox, r3-cache or Jellyfin release is only a candidate
if it is within the maximum resolution and size you set; a copy already on this machine is checked
against the resolution limit only.

</details>

<details>
<summary><strong>Subtitles do not appear automatically</strong></summary>

Enable **Show subtitles automatically** on the Settings page, choose the subtitle language, and
connect SubDL and/or OpenSubtitles under **Control centre → Accounts → Subtitles**. You can still
open the player's subtitle menu and search by hand.

If neither service is connected, the menu says so. If a connected service fails (a bad key, an
outage, a rate limit), the menu shows that error. **No results** means a connected service searched
and found nothing for this title in your language, so try another language or a manual search.

</details>

<details>
<summary><strong>The AI assistant says no model is connected</strong></summary>

The AI features only ever talk to an [Ollama](https://ollama.com) you run yourself. Install it and
pull a model (`ollama pull llama3.2`); running at `http://127.0.0.1:11434` on this machine it is
found on its own, even if started after the app.

Open **Control centre → AI** for the cases that are not automatic: a server on another machine, a
different port, or a specific model. Enter the address, press **Check** to list what is installed,
pick a model and press **Connect**. **Disconnect** turns the AI features off, including the
automatic look, until you connect again. For an Ollama on another machine, that machine must have
`OLLAMA_HOST` set to something other than localhost to accept network connections at all.

</details>

<details>
<summary><strong>A Watch Party guest cannot connect</strong></summary>

On the same LAN, check that the firewall allows the app. Across the internet, hosting depends on
your router: either the automatic port mapping succeeded, you forwarded the party's TCP port, or an
R3 Party Sync relay is connected under **Control centre → Community → Watch Party relay**. With the
relay connected there is nothing to switch: the invite already carries the relay route and each
guest's app uses the first route that answers.

</details>

<details>
<summary><strong>A media-server connection test fails</strong></summary>

Check the server URL, credentials or API key, and whether the server is reachable from this machine.
Use the full base URL, including `http://` or `https://` and a non-default port when needed.

</details>

## Security and privacy

- Keep API keys, account credentials, and party invitations private; never commit them.
- Prefer HTTPS for remote service connections.
- Know what the app talks to. Without any account it contacts Cinemeta (`v3-cinemeta.strem.io`),
  Simkl's public feed (`data.simkl.in`), Kitsu (`kitsu.io`), AniList (`graphql.anilist.co`),
  Aniskip (`api.aniskip.com`), YouTube's no-cookie domain for trailers, Cloudflare's speed-test
  endpoint when you run the connection test, and GitHub for updates and the Anime4K pack. Playing
  from TorBox also queries the Torrentio (`torrentio.strem.fun`) and Comet
  (`cometfortheweebs.midnightignite.me`) add-ons for releases; neither is configurable. Every
  other host is one you connected yourself.
- The [security review playbook](docs/SECURITY_REVIEW.md) lists the manual checks worth running
  (renderer-to-main capability, the HTTP proxy, secrets, the packaged app, media processing) and
  the automated checks still to add.
- Report security issues privately to the maintainer rather than in a public issue.

## Known limitations

Found by the 2026-09-27 audit and tracked in [docs/AUDIT-2026-09-27.md](docs/AUDIT-2026-09-27.md):

- A watch mark made while a tracking service is unreachable is dropped rather than retried.
- A partly downloaded title can only resume from the source it came from, so it still needs that
  source connected.

Three problems the same audit found are fixed: anime is now served from the r3-cache tier, cached
titles play without TorBox or Jellyfin, and plan-to-watch and history pushes for a title keep
their order. The placeholder weather readout is gone, and the Simkl episode fallback now sends
its client id.

## License

R3 Media Hub is open source under the [MIT License](LICENSE): anyone may use, change and share it,
as long as the copyright notice stays with it. If you build on it, a mention of R3 Media Hub is
appreciated. The player, fonts and other components it ships or fetches keep their own licenses,
listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Contributing

Issues and focused pull requests are welcome. Pull requests target `preview`; every merge there
publishes a Preview build, and Stable is promoted by hand. Run the four CI commands above before
submitting, keep credentials and generated build output out of commits, and let Prettier, ESLint
and TypeScript keep the style consistent.

---

<div align="center">
  Built with Electron, React, and TypeScript. Playback is <a href="https://mpv.io">mpv</a> (GPL),
  fetched at install time from shinchiro's Windows builds.
</div>
