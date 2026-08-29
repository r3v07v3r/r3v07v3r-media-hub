<div align="center">
  <img src="build/icon.png" alt="R3 Media Hub logo" width="112" />

# R3 Media Hub

**A desktop home for browsing, tracking, and playing movies, series, and anime.**

[![Electron](https://img.shields.io/badge/Electron-39-47848F?logo=electron)](https://www.electronjs.org/)
[![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=111)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

</div>

R3 Media Hub is a cross-platform Electron application that brings discovery, watch history,
downloads, playback, and social viewing into one interface. Browse the catalog without an
account, then connect either TorBox or your own Jellyfin/download stack when you are ready to
play something. Optional metadata, tracking, and subtitle services add to the experience.

> [!IMPORTANT]
> R3 Media Hub does not provide media, a TorBox subscription, or a media server. You are
> responsible for the services and libraries you connect and for ensuring that your use of media
> complies with applicable law.

## At a glance

```text
 Discover a title        Choose how to watch          Keep everything organized
 ┌─────────────────┐     ┌─────────────────────┐      ┌────────────────────────┐
 │ Movies          │     │ Use best source     │      │ Continue watching      │
 │ Series          │ ──▶ │ Select an episode   │ ──▶  │ Watch history          │
 │ Anime           │     │ Pick audio/subtitles│      │ My Stuff & downloads   │
 └─────────────────┘     └─────────────────────┘      └────────────────────────┘
           │                         │                            │
           └──────────── Invite friends to a Watch Party ───────┘
```

### What it can do

- **Browse movies, series, and anime** with search, a trailer on the title page, seasons,
  episodes, ratings, the age certificate for your region, and recommendations. Filter by genre,
  year, minimum rating, runtime, season or episode count, and status, hide what you have already
  watched, and save any combination as a named view that comes back as a chip. Cast and crew names
  are clickable — they open what else of theirs is in your catalog, and typing a director's name in
  search finds their films rather than films with their name in the title. A film's page lists the
  rest of its collection; an anime's lists its prequels and sequels in order. Where a title can be
  streamed, rented or bought in your region is shown alongside, from JustWatch via TMDB.
- **Play from local files, a media server, or TorBox** with automatic source selection,
  audio-language preferences, playback buffering, subtitle selection, and resume progress.
- **Control playback properly** — speed from 0.5× to 2×, chapter navigation, audio and subtitle
  sync offsets, subtitle size, height, colour and backdrop, a night mode that evens out quiet
  dialogue against a loud score, seek-bar thumbnail previews, and a sleep timer that can stop at
  the end of the episode. Frame step, an A-B loop and a screenshot button round out the Playback
  menu, on <kbd>.</kbd>, <kbd>,</kbd> and <kbd>s</kbd> to match mpv and VLC muscle memory.
- **Skip the intro and the credits.** Anime uses Aniskip's community-submitted times; movies and
  series read the release's own chapter marks, so a mislabeled chapter is never trusted.
- **Keep watching a series** — when an episode ends, the next one is offered on a post-play card
  and starts after a short countdown. Turn it off under **Settings → Playback → Episodes**.
- **Track what you watch** locally and, if desired, sync compatible activity with Simkl, Trakt and
  MyAnimeList. Where a service disagrees with what is stored here, the difference is shown for you
  to settle rather than resolved silently.
- **Rate what you have seen** out of 10 on a title's page. Scores are private to the profile that
  gave them, and they steer what gets suggested — a genre watched often but enjoyed little stops
  leading the recommendations.
- **Build a personal library** in **My Stuff**, with tabs for your lists, what is in progress, what
  you have finished, what you have rated, a calendar of what is airing, your full viewing
  history, your stats, and what you
  have set aside. Make as many named lists as you like alongside My List, and add titles to them
  from their own page.
  Any single viewing can be removed from the history without un-watching the episode.
- **Manage downloads** and optionally connect Jellyfin, Sonarr, Radarr, qBittorrent, and Prowlarr.
  Torrents can be paused, resumed and removed from the Downloads page, with keeping or deleting the
  files asked separately. With Prowlarr connected, the page names any indexer currently in a failure
  backoff, so an empty Sonarr/Radarr search stops being unexplained.
- **Pre-fetch over your LAN with a cache server.** Run [r3-cache](daemon/README.md) on any Windows
  or Linux box on your network and it downloads what you plan to watch ahead of time, then serves it
  over one LAN hop instead of a slow internet link. The app finds it by itself; pair it under
  **Settings → Cache server** with the code from its console. Everything it stores expires on its
  own.
- **Ask Sonarr or Radarr for a title** straight from its page, picking the quality profile and
  folder, with a search starting as soon as it is added. Movies and series only — anime is
  catalogued by Kitsu id, which neither service can look up.
- **Watch together in Rooms** over a direct LAN/WAN connection or an optional R3 Party Sync
  relay, with a shared queue, synchronized playback, and short-lived encrypted room chat.
- **Keep a Friends group open in the background.** Share a group code and you can see what everyone
  is watching, then either join their room or start the same title on your own — you are asked
  which, each time. Nobody hosts the group, so it keeps working when any one person is offline, and
  you decide what you share.
- **Hear about new episodes** of anything in My List, as a desktop notification. Off until you
  turn it on in **Settings → General**, checked a few times a day, and never while you are
  watching something.
- **Use separate profiles**, including Kids and PIN-protected profiles. Each profile keeps its
  own list, watch history, ratings and resume points.
- **Stay updated on your own terms.** **Settings → About & Updates** checks a few times a day and
  offers a **Stable** or a **Preview** channel; an update downloads in the background and installs
  when you restart.
- **Back up your library** to a single file and restore it on another machine, from
  **Settings → General → Your library**. Service credentials stay on the machine that holds them.
- **Bring an existing history in.** The same section imports IMDb's ratings export and a Letterboxd
  "Export Your Data" zip; a connected Trakt account imports from **Settings → Accounts**. All three
  keep the original dates, only fill in what is missing, and are safe to run twice.
- **Search and ask in one field.** Typing in the top bar searches the movie, series and anime
  catalogs and shows what it finds — real titles you can open, with or without an AI model. With
  one connected, its answer appears underneath: what the top result is, whether it fits what
  you have actually watched, and other titles worth trying, each one looked up so it opens like
  anything else.
- **Run the AI locally.** The assistant and the Recommend Next buttons run on an
  [Ollama](https://ollama.com) model on your own machine, and nothing is sent to a hosted
  service. An Ollama running here at its usual `http://127.0.0.1:11434` is found and used on its
  own — there is nothing to set up. Without one, the search still answers, the assistant says
  plainly that no model is connected, and the Recommend Next buttons fall back to a pick they
  openly label as random.

## Quick start

### Install a release

Download the installer for your platform from the
[GitHub Releases page](https://github.com/R3v07v3R/r3v07v3r-media-hub/releases):

- **Windows:** NSIS setup executable
- **macOS:** DMG
- **Linux:** AppImage, Snap, or Debian package

Open R3 Media Hub after installation. The catalog is browsable immediately. For playback,
connect either a TorBox account or your own media/download services (Jellyfin, Sonarr, Radarr,
and qBittorrent).

### Connect a playback source and play your first title

1. Open **Settings** in R3 Media Hub.
2. Connect at least one playback source:
   - **TorBox:** copy the API token from your TorBox account settings, paste it into the
     **TorBox** section, and choose **Connect**; or
   - **Your own library/download stack:** configure Jellyfin and/or Sonarr, Radarr, qBittorrent,
     and Prowlarr under **Settings → Media services**, then save and test the connections.
3. Optional: under **Settings → Playback → Subtitles**, choose your preferred spoken-audio and
   subtitle languages.
4. Open **Movies**, **Series**, or **Anime**, select a title, and choose **Watch**.
5. For a show, select its season and episode first. R3 Media Hub remembers playback progress so
   you can continue later from Home or My Stuff.

The usual path through the app is:

```text
Settings → Connect TorBox OR your media/download services
                              ↓
Movies / Series / Anime → Title details → Watch → Best available source
                 ↓                              ↓
              My Stuff                  Continue Watching
```

When more than one source is connected, R3 Media Hub picks a stream in two stages. Two tiers
short-circuit — if either holds a playable copy that still meets your quality target, nothing else
is contacted:

1. **This machine's own cache** — a stream already on disk from an earlier play. No network at all.
   A partial download is resumed from the source it originally came from rather than restarted.
2. **A paired r3-cache server** on your LAN, when it holds the title complete.

Everything else — your **media server** and **TorBox** — is then scored together and the best
candidate wins. The score weighs whether the copy can be played right now, its resolution, its
audio language, and where it lives. How much that last part counts is yours to set under
**Settings → Playback → Where to play from**:

- **Media server** — the local copy wins essentially always. For a slow connection, where the file
  was put on the server precisely so it would be used.
- **Balanced** (the default) — the local copy wins ties and beats one resolution tier down. A local
  1080p is preferred to a remote 2160p; a local 720p is not.
- **Best quality** — where a copy lives stops mattering and the best release wins outright.

So connecting TorBox alongside your own services does not normally bypass a local copy, but on
**Best quality** it deliberately can. The maximum-resolution and maximum-size limits under
**Settings → Playback → Network** apply to every tier, including the cached ones.

## Using the app

| Destination   | What you will find there                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Home**      | Featured picks, continue watching, recommendations that say why they were picked, moods, and optional system-performance gauges.                            |
| **Movies**    | Movie discovery and filtering. Select a card to see its synopsis, ratings, related titles, and playback actions.                                            |
| **Series**    | TV discovery plus season and episode selection.                                                                                                             |
| **Anime**     | Anime discovery, season groupings, episode progress, and anime-specific tracking.                                                                           |
| **My Stuff**  | Eight tabs: lists, in progress, watched, rated, calendar, history, stats, and what you set aside.                                                           |
| **Downloads** | Streams cached on this machine, qBittorrent torrents, the Sonarr and Radarr queues, failing Prowlarr indexers, and what the app is doing in the background. |
| **Settings**  | Playback, language, network, profiles, connected services, Rooms, and updates.                                                                              |

On desktop, press <kbd>Ctrl</kbd>+<kbd>B</kbd> (or <kbd>⌘</kbd>+<kbd>B</kbd> on macOS) to collapse
or expand the sidebar. On narrow windows, primary navigation moves to the bottom; use **More**
for Downloads and Settings.

### Optional service connections

Playback requires either **TorBox** or your own connected media/download services. Connecting
both is supported; the app applies the local → media server → download stream priority described
above. Metadata, tracking, subtitle, and relay services remain optional:

| Service             | Purpose                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **TMDB**            | Richer artwork and metadata.                                                                                                       |
| **OMDb**            | Additional movie and series ratings, including Rotten Tomatoes data where available.                                               |
| **Simkl**           | Account-based watch tracking and catalog enrichment.                                                                               |
| **Trakt**           | Watch history, ratings and scrobbling in both directions, with a one-off import of an existing account.                            |
| **MyAnimeList**     | Anime list and progress synchronization.                                                                                           |
| **SubDL**           | Search for and automatically apply subtitles, with no daily download limit.                                                        |
| **OpenSubtitles**   | The same, from a second catalogue (a free account allows 5 downloads per day).                                                     |
| **Jellyfin**        | Play content from an existing personal media library.                                                                              |
| **Sonarr / Radarr** | Connect series and movie management to the local download workflow.                                                                |
| **qBittorrent**     | Supply and manage downloads for the local playback workflow.                                                                       |
| **Prowlarr**        | Indexer health, so an empty Sonarr/Radarr search can be told apart from an indexer locked out on a bad key.                        |
| **r3-cache**        | A pre-fetch server on your own LAN. Zero-config — see [daemon/README.md](daemon/README.md).                                        |
| **R3 Party Sync**   | Relay Watch Party traffic when a direct connection is not suitable.                                                                |
| **Ollama**          | Run the AI assistant and recommendations on a language model you host yourself. Detected automatically when it is on this machine. |

Add or remove these integrations from **Settings**. API credentials are entered in the desktop
app rather than in the source tree.

### Start or join a Room

1. Open **Rooms** in the top navigation and set the name friends should see.
2. Choose direct hosting for a LAN/WAN room, or configure **Room relay** in Settings for relay mode.
3. Host a room and send its generated invite to the other viewers through a trusted channel.
4. Guests join with the invite. Participants can chat, suggest titles, and vote in the shared queue.
5. Start a queued title; play, pause, and seek events are synchronized for the room.

Direct hosting advertises your local network address and can attempt router port mapping. If
that is unavailable or undesirable, use the relay option instead. Treat party invites as secrets
while a room is active.

## Run from source

### Requirements

- [Node.js](https://nodejs.org/) 20 or newer
- npm (included with Node.js)
- Git
- Platform build tools if you intend to create an installer

```bash
git clone https://github.com/R3v07v3R/r3v07v3r-media-hub.git
cd r3v07v3r-media-hub
npm install
npm run dev
```

Useful project commands:

| Command                | Purpose                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------- |
| `npm run dev`          | Start Electron with the Vite development server and hot reload.                     |
| `npm start`            | Preview an already-built application.                                               |
| `npm test`             | Run the repository's focused test suite.                                            |
| `npm run lint`         | Check JavaScript and TypeScript with ESLint.                                        |
| `npm run typecheck`    | Type-check both Electron/Node and renderer projects.                                |
| `npm run build`        | Type-check and produce the Electron application bundles.                            |
| `npm run build:win`    | Create a Windows installer.                                                         |
| `npm run build:mac`    | Create a macOS package.                                                             |
| `npm run build:linux`  | Create Linux AppImage, Snap, and Debian packages.                                   |
| `npm run build:daemon` | Build the r3-cache LAN pre-fetch daemon — see [daemon/README.md](daemon/README.md). |

### Architecture

```text
src/
├── main/                 Electron main process
│   ├── ipc/              Validated IPC endpoints
│   └── media-hub/        Catalog, playback, services, tracking, and parties
├── preload/              Narrow renderer-to-main bridge
├── renderer/             React user interface
└── shared/               Types and logic shared across process boundaries

React renderer ──validated IPC──▶ Electron main ──HTTPS / WebSocket──▶ services
       ▲                              │
       └──────── local playback ◀─────┘
```

The renderer does not receive direct Node.js access. Service calls, credential storage, local
playback proxying, and Watch Party networking are handled in the Electron main process and
exposed through the preload bridge.

Two optional companions ship from the same repository and are documented separately:
[`daemon/`](daemon/README.md) is the r3-cache LAN pre-fetch server, and
[`party-sync-worker/`](party-sync-worker/README.md) is the Watch Party relay you deploy yourself.

## Troubleshooting

<details>
<summary><strong>The catalog opens, but a title will not play</strong></summary>

Confirm that at least one playback path is connected. For TorBox, check that **Settings →
TorBox** says **Connected** and reconnect if the token was revoked or expired. For your own
stack, test the Jellyfin, Sonarr, Radarr, and qBittorrent connections under **Settings → Media
services** and confirm the requested title exists or can be obtained.

If a title plays but not from where you expected, check **Settings → Playback → Where to play
from** and the quality limits beside it — a release is only a candidate if it meets the maximum
resolution and size you set, and those limits apply to a cached or media-server copy exactly as
they do to a TorBox one.

</details>

<details>
<summary><strong>Subtitles do not appear automatically</strong></summary>

Enable **Show subtitles automatically**, choose the correct subtitle language, and connect
SubDL and/or OpenSubtitles in Settings. You can still open the playback subtitle menu and search
manually.

Both providers are searched together and the results are shown in one list, tagged with the
service each came from. SubDL is listed first because its downloads are unmetered, so the
automatic fetch prefers it; OpenSubtitles allows only 5 downloads per day on a free account. If
the menu says "No results", check that at least one of the two is still connected.

</details>

<details>
<summary><strong>The AI assistant says no model is connected</strong></summary>

The AI features have no hosted service behind them — they only ever talk to an
[Ollama](https://ollama.com) instance you run yourself. Install Ollama and pull a model
(`ollama pull llama3.2`); if it is running on this machine at the usual
`http://127.0.0.1:11434`, R3 finds it and connects on its own, with nothing to enter. Starting
Ollama after R3 is fine — the next question you ask picks it up.

Open **Settings → AI** for the cases that are not automatic: a server on another machine, a
different port, or choosing a specific model. Enter the address, press **Check** to list what is
installed there, pick a model and press **Connect**. **Disconnect** turns the AI features off
altogether, including the automatic look, until you press **Connect** again.

If **Check** cannot reach it, confirm Ollama is running (`ollama list`) and that the port matches.
For an instance on another machine, that machine must have `OLLAMA_HOST` set to an address other
than localhost for it to accept connections from the network at all.

</details>

<details>
<summary><strong>A Watch Party guest cannot connect</strong></summary>

For direct hosting, first try the same LAN and verify that local firewall rules allow the app.
WAN hosting additionally depends on router/NAT behavior. Configure R3 Party Sync and use relay
mode when direct connectivity is unavailable.

</details>

<details>
<summary><strong>A media-server connection test fails</strong></summary>

Check the server URL, credentials/API key, and whether the server is reachable from this machine.
Use the full base URL, including `http://` or `https://` and a non-default port when needed.

</details>

## Security and privacy

- Keep API keys, account credentials, and Watch Party invitations private; never commit them to
  the repository.
- Prefer HTTPS for remote service connections.
- Review the project's [security review](docs/SECURITY_REVIEW.md) for the current trust model,
  controls, and known limitations.
- Report security issues privately to the maintainer rather than opening a public issue with
  sensitive details.

## Contributing

Issues and focused pull requests are welcome. Before submitting a change, run:

```bash
npm test
npm run lint
npm run typecheck
```

Please keep credentials and generated build output out of commits. This repository uses Prettier,
ESLint, and TypeScript for consistency.

---

<div align="center">
  Built with Electron, React, and TypeScript.
</div>
