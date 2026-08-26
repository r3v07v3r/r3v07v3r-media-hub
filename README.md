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

- **Browse movies, series, and anime** with search, genre and status filters, title details,
  seasons, episodes, ratings, and recommendations.
- **Play from local files, a media server, or TorBox** with automatic source selection,
  audio-language preferences, playback buffering, subtitle selection, and resume progress.
- **Keep watching a series** — when an episode ends, the next one is offered on a post-play card
  and starts after a short countdown. Turn it off under **Settings → Playback → Episodes**.
- **Track what you watch** locally and, if desired, sync compatible activity with Simkl and
  MyAnimeList.
- **Rate what you have seen** out of 10 on a title's page. Scores are private to the profile that
  gave them, and they steer what gets suggested — a genre watched often but enjoyed little stops
  leading the recommendations.
- **Build a personal library** in **My Stuff**, including watchlisted, liked, disliked, watched,
  and in-progress titles.
- **Manage downloads** and optionally connect Jellyfin, Sonarr, Radarr, and qBittorrent.
- **Ask Sonarr or Radarr for a title** straight from its page, picking the quality profile and
  folder, with a search starting as soon as it is added. Movies and series only — anime is
  catalogued by Kitsu id, which neither service can look up.
- **Watch together in Rooms** over a direct LAN/WAN connection or an optional R3 Party Sync
  relay, with a shared queue, synchronized playback, and short-lived encrypted room chat.
- **Use separate profiles**, including Kids and PIN-protected profiles. Each profile keeps its
  own list, watch history, ratings and resume points.
- **Back up your library** to a single file and restore it on another machine, from
  **Settings → General → Your library**. Service credentials stay on the machine that holds them.
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
   - **Your own library/download stack:** configure Jellyfin and/or Sonarr, Radarr, and
     qBittorrent under **Media Servers & Downloads**, then save and test the connections.
3. Optional: under **Subtitles**, choose your preferred spoken-audio and subtitle languages.
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

When more than one source is connected, R3 Media Hub resolves playback in this order:

1. **Local content** already available on the device.
2. **Media-server content** available through your connected library services.
3. **Download streams** supplied through the connected download/TorBox services.

This means connecting TorBox alongside your own services does not bypass a local copy: the app
uses local content first, then checks the media server, and only then falls back to a download
stream.

## Using the app

| Destination   | What you will find there                                                                                         |
| ------------- | ---------------------------------------------------------------------------------------------------------------- |
| **Home**      | Featured picks, continue watching, recommendations, moods, and optional system-performance gauges.               |
| **Movies**    | Movie discovery and filtering. Select a card to see its synopsis, ratings, related titles, and playback actions. |
| **Series**    | TV discovery plus season and episode selection.                                                                  |
| **Anime**     | Anime discovery, season groupings, episode progress, and anime-specific tracking.                                |
| **My Stuff**  | Watchlist, liked/disliked titles, watched items, and viewing history.                                            |
| **Downloads** | Active and completed TorBox downloads with relevant actions.                                                     |
| **Settings**  | Playback, language, network, profiles, connected services, Rooms, and updates.                                   |

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
| **MyAnimeList**     | Anime list and progress synchronization.                                                                                           |
| **SubDL**           | Search for and automatically apply subtitles, with no daily download limit.                                                        |
| **OpenSubtitles**   | The same, from a second catalogue (a free account allows 5 downloads per day).                                                     |
| **Jellyfin**        | Play content from an existing personal media library.                                                                              |
| **Sonarr / Radarr** | Connect series and movie management to the local download workflow.                                                                |
| **qBittorrent**     | Supply and manage downloads for the local playback workflow.                                                                       |
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

| Command               | Purpose                                                         |
| --------------------- | --------------------------------------------------------------- |
| `npm run dev`         | Start Electron with the Vite development server and hot reload. |
| `npm start`           | Preview an already-built application.                           |
| `npm test`            | Run the repository's focused test suite.                        |
| `npm run lint`        | Check JavaScript and TypeScript with ESLint.                    |
| `npm run typecheck`   | Type-check both Electron/Node and renderer projects.            |
| `npm run build`       | Type-check and produce the Electron application bundles.        |
| `npm run build:win`   | Create a Windows installer.                                     |
| `npm run build:mac`   | Create a macOS package.                                         |
| `npm run build:linux` | Create Linux AppImage, Snap, and Debian packages.               |

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

## Troubleshooting

<details>
<summary><strong>The catalog opens, but a title will not play</strong></summary>

Confirm that at least one playback path is connected. For TorBox, check that **Settings →
TorBox** says **Connected** and reconnect if the token was revoked or expired. For your own
stack, test the Jellyfin, Sonarr, Radarr, and qBittorrent connections under **Media Servers &
Downloads** and confirm the requested title exists or can be obtained. If several sources are
connected, remember that R3 Media Hub checks local content first, media-server content second,
and download streams last.

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
