<div align="center">
  <img src="build/icon.png" alt="R3 Media Hub logo" width="112" />

# R3 Media Hub

**A desktop home for browsing, tracking, and playing movies, series, and anime.**

[![Electron](https://img.shields.io/badge/Electron-45-47848F?logo=electron)](https://www.electronjs.org/)
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
[audit report](docs/AUDIT-2026-09-27.md) records how an earlier audit checked it; what is still open
is under [Known limitations](#known-limitations).

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

- **Browse and filter** movies, series and anime, with search, a trailer on the title page, seasons
  and episodes, ratings, similar titles, and recommendations. Filter by genre, year and minimum
  rating, plus runtime for movies, number of seasons and episode length for series, episode count
  for anime, and status for series and anime. **Hide Watched** (anything you have started or
  watched), **Hide Completed** (shows you are caught up on) and **Hide Disliked** (titles you marked
  **Not interested**, which collect under My Stuff → Not for me) can be combined. The Settings
  page's Browsing card sets which start on, and Hide Disliked starts on. A page's own toggle shows
  them again. **Scan deeper** on a category page pulls in more of the catalog than loaded by itself.
  **Save view** keeps the current filters under a name you type in place (Enter or clicking away
  saves, Escape cancels); it is offered while a filter is on.
- **Not interested.** A title you marked Not interested that still shows is greyed and marked with a
  thumbs-down: on cards and grid tiles, in a title page's Similar row and Rest of the series list,
  in the Similar tab of the Movies, Series and Anime side panel, as a library page's featured title
  when Hide Disliked is off, and in the assistant's answers. The Home hero names it beside the year.
  The Similar rows and tab, Rest of the series, a person's page, My Stuff's Planned and Lists, and
  the assistant's answers never hide these titles; the Mood page has no toggle of its own and
  follows the Settings default.
- **What is in your library.** A title found only by search joins the library once you open it, plan
  it, mark it watched, set a status on it or mark it Not interested; one pulled from a service's
  plan-to-watch joins when the pull brings it in. Either way it then shows in the grids, My Stuff
  and Home's Planned tab like anything else. A title that arrives by a pull comes in with a name and
  a year but no poster. Opening it adds one, and with Simkl connected the app also looks up the
  missing ones after each catch-up, on the desktop as on the phone and TV; art a title already has
  is never replaced. A one-time background pass, made while the app is idle, adds anything already
  tracked, watched, rated or marked Not interested that the library does not hold; **Services** in
  the control centre lists it as "Adding your titles to the library". After it, a viewing or score
  that comes in for a title the library does not hold, from an import or from Simkl or Trakt, shows
  once you open that title or the catalog's regular refresh lists it.
- **Merged anime.** An anime whose seasons are merged into one show has an "N seasons" chip on its
  poster, its rating is its first season's, and its seasons are tabs on its page. Until the anime
  catalog has been organised for the first time (on a fresh install, for the few minutes that
  takes), every season is its own tile, opens as itself and can be suggested on its own. Later
  refreshes, about every six hours, keep the organised catalog showing until the new one is ready,
  so merged shows stay one tile; anime new in a refresh reach the grids once it is done.
- **Which seasons stay separate.** A later season is left out of the Anime library, on the desktop
  and the phone, only when the app can prove which season of the show's page it is. Any other
  season keeps its own tile and its own page, and what you mark there is kept under it: for example
  two halves (cours) of one season, a season of a show fronted by a recap, a season TheTVDB numbers
  differently from its place, or any season of a show the app has not finished looking up. The
  exact rule is in
  [docs/WATCHLIST-SYNC.md](docs/WATCHLIST-SYNC.md#when-a-members-place-is-not-its-season).
- **A later season on your plan.** A later season left out of the Anime library that is planned at
  Simkl or MyAnimeList keeps its own card on your plan. Opening it, or a link to that season from
  another title, opens the show at that season's tab; Play starts that season's next unwatched
  episode, and marking it watched or not watched changes that season only. On the desktop its badge
  and progress follow what you have watched of that season on the show's page. It stays on Home's
  **Planned** tab even when the show itself is finished, so a planned new season that has not aired
  yet does not drop out of Home.
- **Recommendations that say why.** Home shows the top row; **For You** shows the whole ranking,
  shelved by reason: a franchise continuation, a director or actor who recurs in what you have
  watched, a genre match. After a film or anime, the next part of its series is offered first, and a
  rewatch counts. Your own ratings steer it: a genre you watch often but enjoy little stops leading.
  An anime whose seasons are merged into one show is suggested as that show. Once the anime catalog
  has been organised for the first time (see **Merged anime** above), a later season of a merged
  anime is not suggested on its own, including one that keeps its own tile in the Anime library.
- **A suggestion you act on stays put.** A suggestion you plan, mark watched or mark Not interested,
  from wherever you do it, stays where it is, with its new badge, on Home's row and hero, the For
  You shelves and the Recommended shelf of the Movies, Series and Anime pages, until you go to
  another page; opening a title and coming back, or changing that page's filters, keeps it there.
- **The Recommended shelf and Show me others.** The Recommended shelf on the Movies, Series and
  Anime pages holds the best 18 suggestions of that kind from the whole ranking, with the same
  reasons as Home's row, so a page is not left with a handful of titles when Home's row leans to
  another kind. **Show me others**, on Home's Recommended For You tab and on those shelves, moves
  the suggestions on screen to the back of the row for three weeks, for the current profile, and
  shows what was behind them. They are not hidden: once the fresh titles run out they come back in
  their usual order, and the For You page's shelves keep them in their usual place. **Not
  interested** removes a title for good.
- **Cast and crew are clickable** once a TMDB key is connected: names open what else of theirs the
  catalog holds. Search also lists, after the titles whose name matches, titles whose cast,
  director, creator or story labels contain what you typed. Both reach only titles whose credits the
  app has already fetched (about sixty every half hour while the app is idle, plus any title whose
  page you open), so a new install finds few at first and more over the following sessions. Anime is
  matched on its studio and its AniList story tags (such as "time loop"), not on cast, and needs no
  TMDB key.
- **Moods.** A Browse-by-mood tray on Home, and a full mood page.
- **Calendar.** Its own page: episodes of what you follow, a week back and six weeks ahead. Unaired
  anime episodes show their air date or TBA on the title page and cannot be played early.
- **Not out yet.** A title that has not been released says when instead of offering Play: "Releases
  12 Mar 2027", "Coming 2027" when only the year is known, or "Coming soon" when its source lists it
  as upcoming with no date. Its card, the Home hero and the side panel of the Movies, Series and
  Anime pages show it this way, and the title still opens. Until the catalog's next refresh, a title
  it already held may know only its year.
- **With a TMDB key** (optional): the age certificate for your region, cast and crew,
  the rest of a film's collection, better similar-title lists, and per-season episode data for
  grouped anime. **With an OMDb key**: the Rotten Tomatoes score.
- **Anime franchises in release or story order.** An anime's page lays out its franchise (prequels,
  the main or full story, side stories, spin-offs, recaps, sequels) from Kitsu, with no key needed.
  A show merged from several seasons is treated as one title: what comes before it is what precedes
  its first season, and what comes after is what follows its last. TV seasons are merged, and so is
  a web release (ONA) that TheTVDB numbers as a season of the same series when no TV season or other
  ONA has that number. A film, OVA, special or any other ONA is a title of its own, listed on the show's page
  between the seasons it came out between (on the phone and TV, in a Films and specials row under the episodes, each saying
  which season it follows). On the desktop each entry in the franchise guide says how it relates and
  what it is, for example Side story · OVA or Continue with · Film. A season of the show reads
  Season N and switches the episode list to that season, the title you are on is marked This title
  and is not a link, and anything else opens its own page.
- **Story order.** On the desktop, a Release order / Story order switch puts one list in story order
  instead: the show's seasons, films and specials, and every title they link to directly (a sequel's
  own sequel shows once you open that sequel). Kitsu's prequel and sequel links decide, so a prequel
  made later goes first, and air dates place what the links leave unordered, so it is only as right
  as those links. Story order asks Kitsu about every part of the show, a few at a time, and keeps
  each answer for a day, so on a long franchise the list can take a few seconds to fill; if some
  parts could not be checked, it says the order may be incomplete. The switch starts on Release
  order and remembers your choice on that computer, for every profile on it, so each anime page
  opened afterwards loads in that order. The rest of a film's collection, on its title page, stays
  in release order.
- **Collections.** A sidebar page of whole film-and-series universes: the Marvel Cinematic Universe,
  Star Wars, DC, X-Men, Star Trek, the Wizarding World, Middle-earth, Alien & Predator and the
  MonsterVerse. Each tile shows how many of its titles you have watched, and a universe's page
  numbers every title from first to last, with a **Start with** or **Next** button for the first one
  that is out and you have not finished; a title not out yet says when it is coming. Marvel, Star
  Wars, the Wizarding World and Middle-earth can be shown in story order or in release order; the
  others are shown in release order only. In the Marvel universe a series that runs alongside the
  films has a stop for each season, each where it falls in the story, and where a film lands
  part-way through a season the season is split at that film (Agents of S.H.I.E.L.D. is split four
  times). A season card shows which episodes it covers, the next one to watch and how far through
  that run you are, and **Next** on a season opens the series on that season. Removing a collection
  only hides it for your profile: **Removed collections** at the foot of the page lists them, and
  **Restore** brings one back as it was. Each profile keeps its own collections, and a backup from
  **Your library** includes them.
- **A Trakt list as a collection.** With a Trakt app key saved under **Control centre → Accounts →
  Tracking** (no Trakt sign-in needed), **Browse for more** on the Collections page searches Trakt's
  public lists, or shows the most liked ones, and **Add by link** takes a trakt.tv list link;
  without a key, the page says so, with a **Set up Trakt** button. An added list keeps its films and series, up to
  500, and is read again when you open Collections once it is a day old, so titles its owner adds
  show up; a list Trakt cannot read keeps what it had. If its owner ranked it by hand, it can be
  shown in **List order** as well as release order. Simkl lists cannot be added, because Simkl opens
  them only to PRO and VIP accounts.

### 2. Choose a source — needs TorBox or a Jellyfin server

A title that is already complete in this machine's cache, or that a paired r3-cache server holds for
this device, plays with nothing else connected. Everything else needs **TorBox** or an enabled
**Jellyfin** server; without either, pressing Play says the title is not on this computer or a
paired cache server and asks you to connect one. Sonarr, Radarr, qBittorrent, Prowlarr and Bazarr
are management and status connections, not playback sources: what they fetch becomes playable once
it reaches your Jellyfin library.

When you press **Play**, the app stops at the first of these that has a copy within your quality
limits:

1. **This machine's own cache** — a stream already on disk from an earlier play, checked against
   your resolution limit only. A partial download is resumed from the source it originally came
   from rather than restarted.
2. **A paired [r3-cache](daemon/README.md) server on your LAN**, when it holds the title complete
   and this device may read it: it was fetched for this device, or whoever fetched it shared it (see
   [daemon/README.md](daemon/README.md#who-may-use-what)). A server that has not answered within 3
   seconds is treated as away, and the app moves on.
3. **Your Jellyfin server.** On **Media server** a copy within your limits plays straight away and
   TorBox is not asked, unless you ask for another copy (**Wrong copy? Find another**) or the copy
   lacks your audio language; the server copy is then ranked against TorBox's results. On
   **Balanced**, the default, it also plays straight away unless a copy more than twice as sharp
   could exist within your limits: a 1080p copy always plays, a 720p copy under a 4K limit makes the
   app ask TorBox and compare the two. When the two are compared, the server copy wins unless the
   other is more than twice as sharp and at least as good on everything else. On **Best quality**
   the server copy is ranked against TorBox's search results, but a stream that played that title or
   episode in the last 14 days is checked first and plays on its own. With no TorBox connected, the
   server copy plays on every setting.
4. **TorBox.** The stream that played last time is checked first. Otherwise the Torrentio and Comet
   add-ons are searched for releases, TorBox is asked which of them it already has, and the
   candidates are scored on whether they are the right title, whether they can play right now, their
   resolution and their audio language. The release group whose copy played the show's previous
   episode in your audio language is preferred strongly enough to beat a sharper release from
   another group (a copy that played without your audio does not count), and a remux, a
   lossless-audio release (TrueHD, DTS-HD, DTS:X, Atmos) or one over 25 GB is pushed down because it
   is slow to start streaming, so a plain encode beats a remux when both are ready to play. If
   nothing is cached, the best release is submitted to TorBox and you are told to try again in a few
   minutes. When the copies TorBox has ready lack your audio language but one it has not fetched has
   it, the ready copy plays now and TorBox is also asked to fetch that one, so a later play can use
   it. A copy that opens without your audio is handled as described under **Wrong audio** in Play.

**Control centre → Playback → Network** holds the knobs: **Where to play from** (Media server,
Balanced, Best quality), the maximum video quality and download size that every remote tier must
meet, and a **Connection recommendation** test that measures your connection and sets both to what
it recommends, which you can change afterwards. If the best copy is noticeably below your ceiling,
the app asks once per title per session whether to play it anyway.

**Storage while playing.** On first run the app asks whether video may be cached to disk. **Keep
media on this device** off means memory-only streaming. On, **Where the buffer lives** under
**Control centre → Playback → Storage while playing** picks **Cache to disk** (the default), with a
cache size and folder you choose, or **Memory only**, which keeps a memory buffer (512 MB by
default) and writes nothing to disk. Both answers are reversible. In the background, about ten minutes after launch and then every hour, the app removes cached video that nothing has been added to for a day, and
**Clear** there removes everything except what is playing. The hourly clean-up and **Clear** also
tidy the app's original cache folder after you move the cache elsewhere, and remove stray pieces of
video lying loose in the cache folder.

### 3. Play — needs mpv (bundled with the Windows installer)

Playback is mpv, embedded inside the app's own window on Windows; there is no transcoding.

- **Controls:** speed from 0.5× to 2×, chapter navigation, audio and subtitle sync offsets, subtitle
  size, position, colour and backdrop, a night mode that evens out quiet dialogue against a loud
  score, seek-bar thumbnail previews, and a sleep timer that can stop at the end of the episode. The
  Playback menu opens with **Wrong copy? Find another** (see below), then frame step, an A-B loop
  and a screenshot button.
- **Keys:** <kbd>Space</kbd> play/pause, <kbd>←</kbd>/<kbd>→</kbd> seek, <kbd>↑</kbd>/<kbd>↓</kbd>
  volume, <kbd>PageUp</kbd>/<kbd>PageDown</kbd> chapters, <kbd>f</kbd> fullscreen, <kbd>.</kbd> and
  <kbd>,</kbd> frame step, <kbd>s</kbd> screenshot, <kbd>i</kbd> stream info, <kbd>a</kbd> Anime4K
  on or off, <kbd>Esc</kbd> leave fullscreen, or close the player.
- **Skip the intro and the credits.** A title from the Anime catalog uses Aniskip's
  community-submitted times for its opening and ending; everything else, an anime opened from Movies
  or Series included, reads the release's own chapter marks, using one only when its name is a plain
  intro, recap or credits label and it sits in the right place: an intro in the first quarter and no
  longer than five minutes, credits in the last quarter. A release with no such chapter offers no
  skip.
- **Up next.** When the app knows where the credits start (Aniskip's times for anime, or a chapter
  the release names as its end credits), an Up next card goes up with them and offers the next
  episode beside Skip credits; without those times, as with most TV releases, the card goes up for
  the last minute of an episode longer than five minutes, with **Keep watching** in place of Skip
  credits, which puts it away for that episode. At the end it starts the next episode after a
  10-second countdown. Pointing at the card or tabbing to it once the episode has ended calls the
  countdown off and leaves **Play next** for you to press; doing that during the credits, or
  pressing Skip credits, does not.
- **No Up next card** for a film, after the last aired episode, while the sleep timer is set to stop
  at the end of the episode, for anyone in a Watch Party but the host, or with **Play the next
  episode** switched off on the Settings page (that switch removes the card at the credits as well
  as at the end); Skip credits then shows on its own, like Skip intro, except to a party guest who
  cannot control playback.
- **What counts as watched.** An episode or film counts as watched once you are 80% of the way
  through, or when you press **Play next** during its credits; it is recorded once and sent to the
  services you have connected. If a stream stops well short of its runtime, a different card says
  so and offers Resume or Stop instead of marking the title watched.
- **If the player stops answering** (a jump into a part of a stream that has not arrived yet can
  block mpv), the app ends that player after about ten seconds and reopens the title where it was.
  It does that once for each episode or film you play: a second hang in the same one closes the
  player with "The player stopped responding", and closing the player and opening the title again
  starts afresh. The check does not run while a title is still opening; that waits at least a minute
  and a half, longer when other copies may need trying, and then fails with an error.
- **Wrong audio.** Your audio and subtitle languages (each English unless you change them on the
  Settings page) decide which copy plays. A release's name rarely says what audio it holds, so once
  a copy opens the app reads its tracks. If it has no audio in your language, the app shows "No
  Japanese audio in that copy — trying another" (or whichever language you chose), opens up to three
  other copies in turn, about ten seconds more at worst, and keeps the first that has it; when the
  first answer came from this disk or from the copy that played last, it also searches again. A copy
  that will not open is skipped the same way. If none has your audio, it goes back to the closest
  copy, preferring one with subtitles in your language, and says so once, for example "No copy with
  Japanese audio — playing … with English subtitles." What each copy held is remembered for that
  episode for 14 days, so playing it again goes straight to a copy that worked. An episode already
  on this disk still plays offline.
- **Wrong copy?** If a copy turns out to be a recap, a different episode or a broken file, choose
  **Wrong copy? Find another** at the top of the player's Playback menu. That copy is deleted from
  this machine and not offered for that episode again for a year, and the app searches afresh and
  plays another. A misclick is undone under **On this device** in the Caching section: **Forget
  wrong-copy marks** appears while any episode has one, and takes back every such mark at once. If no other copy is found, nothing plays and the search
  says why. A party guest cannot use it; the host can.
- **If a title will not start**, a message gives the reason with a **Retry** button. It stays until
  you use it or close it, and each title has only one: a second failure replaces it with the latest
  reason.
- **Subtitles:** with **Show subtitles automatically** on (the Settings page), an embedded track in
  your subtitle language is turned on by itself, and if the file has none, one is fetched and
  applied, with a note saying where it came from. The player's **Subtitles** button also searches
  online and applies the result you pick. SubtitleDB is built in and needs no account; SubDL and
  OpenSubtitles join the search when connected. All are searched together; SubtitleDB rows come
  first, then SubDL's, because their downloads are unmetered, and rows matched to the exact release
  playing (SubtitleDB by the torrent's info hash, OpenSubtitles by file hash) go to the top for
  frame-accurate sync. Subtitles in the bottom half of the window are placed from the bottom: while the
  player's bottom bar is open they rise by its height, keeping the same gap above it, and go back
  when it fades. Subtitles in the top half are placed from the top and stay put. Grab the text
  itself (no outline is drawn) and drag to set their height (the same Height the Subtitles menu
  has), which the next title keeps. Series and anime episodes are looked
  up by the show's IMDb id with the season and episode, and OpenSubtitles tries the title when that
  finds nothing, so later anime seasons and shows known by a Japanese name find subtitles too. An
  anime's IMDb id comes from Simkl, so that needs a Simkl Client ID (no sign-in); without one the
  search goes by title, and after you enter one the app looks the id up again within a day. When
  every connected service fails, the menu shows each one's reason.
- **Anime4K** (optional): install the shader pack once from **Control centre → General → Performance
  & Display**. Installing also switches on **Use Anime4K while watching**, which appears there once
  the pack is installed; pick a mode, or switch it off to keep the shaders out of the player. While
  that switch is off, the player has no Anime4K button and <kbd>a</kbd> does nothing; a change to
  the switch or the mode applies from the next title. A title from the Anime catalog, film or
  series, starts with the shaders on; everything else starts with them off, including an anime you
  opened from Movies or Series. The player's Anime4K button or <kbd>a</kbd> switches them for the
  title you are watching, and every episode of that title keeps the choice until the app is closed;
  the next title starts by its own rule. The same card holds **Video scaling** (Standard, High or
  Sharp), the **Playback buffer** preset, and the switch for Home's live CPU, GPU, RAM and network
  gauges.
- **Unsafe files are kept out.** A release whose name advertises an executable is never chosen or
  submitted to TorBox, and any file the app's web content tries to save to disk is refused if its
  type is on the blocklist, with a warning that names the file, where it came from, and the reason.

### 4. Keep track — needs nothing

- **One status per title:** not watched, planned, or watched. A pill on a title's page, in the
  library side panel and on the Home hero cycles through the three, and reads **Watching** on a show
  you are part-way through (a click there marks it watched); the right-click menu (or the **...**
  button on a card, in the Movies, Series and Anime grids too) offers **Plan to watch** and **Mark
  watched** (**Mark all watched** on a series) as separate items, and **Not interested**. Cards also
  carry a thumbs-down button beside the **...** that marks or unmarks **Not interested** in one
  click; it stays lit red on a title you have marked. A planned title can be taken off the plan from
  the same menu, or with **Remove from plan** in the library side panel. On the Movies, Series and
  Anime pages the side panel keeps showing a title after you act on it, even when that takes it off
  the page, so its Undo stays in reach; once you change the filters, the Hide toggles or the search
  so that it is no longer listed, the panel moves on to the page's featured title (changing the sort
  does not). On the episode list, **Mark season watched** acts on a season's aired episodes, and
  <kbd>Ctrl</kbd>- or <kbd>Shift</kbd>-clicking episodes selects several to mark at once. When you
  open a title, its episode list says "Checking what you've watched…" until your watched episodes
  have loaded; before that line goes, an episode without a tick may simply not have been checked
  yet, and if the lookup fails the line goes and the episodes read as unwatched. Play on a series
  card starts the next episode you have not watched, not the first. Lists are separate from status.
- **Undo and Remove.** Marking a whole series watched marks every aired episode; marking or clearing
  it shows a toast whose **Undo** stays until you press it or close it. Plan to watch, Remove from
  plan and **Not interested** each show a toast with an **Undo** for eight seconds. Undo after
  Remove from plan puts the title back as it was, with the date you planned it and its new-episode
  count, and with **Keep watchlists in sync** on it is added back at your services. **Remove** on a
  Continue Watching card takes the show off your plan, which is what keeps it in that row; what you
  have watched of it stays, and the toast that follows has the same eight-second **Undo** as Remove
  from plan, which puts the show back on your plan as it was and back in the row. For an anime
  season that is planned as its own card, it takes that season off, not the whole show. A toast that
  repeats one already on screen replaces it. At most eight show at once; past that, the oldest that
  would close by itself goes first, so an Undo or Retry that waits for you stays.
- **Rate what you have seen** out of 10 on a title's page. Each profile keeps its own scores, and
  they steer recommendations. If Trakt is connected, scores for films and series, and clearing one,
  are also sent to that account; anime scores are not sent. A score, or a cleared one, that does not
  reach Trakt is kept and sent again with each sync, only to the account it was given under, and the
  newest score for a title wins (see [Sync](#5-sync--optional-one-account-per-service)).
- **My Stuff** has seven tabs: **Planned** (filterable by kind and by the service it came from, with
  anything not out yet pulled to the top), **Watched**, **Lists** (your named
  lists, plus any lists on a connected Trakt or Simkl account, read-only), **Rated**, **History**
  (the 500 most recent viewings; any single viewing can be removed without un-watching the episode),
  **Stats**, and **Not for me**. Planned keeps a title you also marked Not interested, greyed out
  and tagged, instead of hiding it; Hide watched and Hide completed still apply there if you
  switched them on in Settings. Lists always show everything on them, whatever the hide settings.
  **+ New list** and **Rename** take a list's name in place; My List itself cannot be renamed.
  Titles you are part-way through are on Home's Continue watching panel, and Planned is refreshed
  from the services with **Sync now** on the Watchlists panel under **Accounts → Tracking**.
- **Profiles**, each with its own list, history, ratings and resume points, an optional PIN and an
  optional **Kids** badge. Neither restricts what can be browsed or played; see
  [Known limitations](#known-limitations).
- **Hear about new episodes** of anything you follow, as a desktop notification. Off until you turn
  it on under **Control centre → General**, checked a few times a day, never while you are watching.

### 5. Sync — optional, one account per service

Each tracking service needs its own API application: create one on the service's developer site and
enter the Client ID (and, for Trakt, the client secret; MyAnimeList's is optional) under
**Control centre → Accounts**.

| Service         | What it does                                                                                                                                                                                                                                                                                                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Simkl**       | Pushes watch history (and live scrobbles, if turned on); takes in what was watched elsewhere when the app opens and comes back to the front, adding only; syncs plan to watch both ways for films and series and takes in its anime plan; shows your Simkl lists; settles movie disagreements in **Sync review**.                                                                 |
| **Trakt**       | Pushes watch history, ratings and (if turned on) live scrobbles for movies and series (anime is not sent); syncs the watchlist both ways for films and series and reads your lists; imports an existing account's history and ratings once, and from then on takes in what is watched there every half hour, when the app opens and when it comes back to the front, adding only. |
| **MyAnimeList** | Pushes anime progress and syncs the plan-to-watch list; **Preview sync with MAL** shows what would change before you apply it.                                                                                                                                                                                                                                                    |

**Keep watchlists in sync** (under Accounts → Tracking; with no service connected, it and **Sync
now** show a **Set up** button instead) is the two-way rule: planning or un-planning
here pushes out, and a title this app pulled in from a service is removed here once no service lists
it any more. The setting covers the plan to watch only: watched history reaches the services either
way. A show you have started watching here is the exception: it stays on your plan even when a
service drops it, because Simkl moves a show off plan to watch as soon as you start it, and
MyAnimeList does once a push from here carries the season's total. If you are done with it, take it
off your plan here. Apart from that setting, a show Simkl lists as watching, with a viewing in the
last year, is put on your plan, and so into Continue Watching, when a viewing of it made elsewhere
comes in. Anime plans go to MyAnimeList, not to Simkl. The rules are written down in
[docs/WATCHLIST-SYNC.md](docs/WATCHLIST-SYNC.md).

**Scrobble while playing** (same place) is off on a new install until you turn it on; without Simkl
or Trakt connected, a **Set up** button stands in for the switch. An install
that already had Simkl or Trakt connected when this default arrived was switched on once, and the
switch is yours from then on. A finished
episode or film is sent to Simkl and Trakt either way; scrobbles add a request for every start,
pause and stop, and Simkl allows an account 500 requests a day, shared with a linked phone.

A mark, un-mark, season or whole title that does not reach a service (offline, the service down, a
rate limit) is kept and sent again with each sync: every half hour, on **Sync now**, and a few
seconds after a choice in **Sync review**. After ten tries the service refused (a try made while
offline, rate-limited or while the service is failing does not count), or 30 days, it is given up
on: it leaves the count and goes into the log, and nothing else says so. A rating Trakt does not
take is kept and given up on the same terms. On the desktop the show-by-show comparison below sends
a show's missing episodes again the next time it reads that service's record (Trakt's whenever it
changes; Simkl's after it changes, at most every six hours), and an un-mark that never reached
Simkl can come back from Simkl.

What is waiting belongs to the sign-in it failed under: connecting the service again drops it
unsent. Trakt and MyAnimeList renewing their sign-in on their own does not.

The Watchlists panel under Accounts → Tracking says how many titles still have watched changes
waiting, and for which services: a 12-episode season of a series marked while offline, with Simkl
and Trakt connected, reads "Watched changes for 1 title have not reached Simkl and Trakt yet". The
figure is read when the panel opens and after **Sync now**.

**Anime goes to Simkl and MyAnimeList one season at a time.** Both keep an entry per anime season
while this app shows a franchise as one show, so marking season 2 episode 3 here marks episode 3 of
the season-2 entry there. A season is sent only to the entry the app can show is that season of the
show's page. Specials, and a season of the show's page that the app cannot match to an entry, stay
watched here but are never sent when marked on the show's page. Such a season has a small dot on its
pill on the desktop, and when it is open a line under the pills says "Not sent to Simkl", "Not sent
to MyAnimeList" or "Not sent to Simkl or MyAnimeList", naming only the services that are connected.
That can include the first season of a show fronted by a recap or by one half of a season. A later
season that keeps its own tile is sent as an entry of its own when marked on its own page. The rules
are in [docs/WATCHLIST-SYNC.md](docs/WATCHLIST-SYNC.md#when-a-members-place-is-not-its-season).

**Until the anime catalog has been organised for the first time** (see **Merged anime** under
Discover), a later season marked or un-marked on the show's page is kept with the other changes
still owed and sent to Simkl once the catalog is organised. A MyAnimeList change on a merged anime
with a later season involved waits the same way, rather than sending the first season's entry the
count of the whole show.

**Apply sync** with MyAnimeList places each episode it brings in again rather than trusting the
preview: one that can no longer be placed is counted among the failed ones and stays in the list
(preview again to see where it stands now). Ratings and the counts sent to MyAnimeList are applied
as the preview showed them. The preview already lists a show's own entry the app cannot place as
unmatched, and nothing is done with it. Until the anime catalog has been organised for the first
time, Apply refuses altogether and asks you to preview again. With Simkl connected, Apply also marks
the episodes it brings in on your Simkl account; a copy that does not get through is kept and sent
again like a mark (above). When some entries fail, they stay in the preview and the ones that went
through leave it, so pressing Apply again tries only those; the line under the button says how many
failed and gives the reason for the first one.

On the desktop, the watched episodes of each show are also compared with Simkl's and Trakt's whole
record of that show whenever either changes (Simkl's at most every six hours), and the two are
merged: episodes watched here that a service lacks are sent to it, with the date you watched them,
and the first time a Trakt account is compared, its episodes of the shows you have here are taken
in. The comparison itself removes nothing: an episode leaves a service only when you un-mark it here
or settle its show in **Sync review** below. On a merged anime with a Simkl entry the app cannot
place, only the seasons of the show's page that no entry can be matched to are left out of the
comparison (the same seasons the page marks as not sent): a season fronted by a recap, two parts of
one season, or a later season the page numbers differently. The show's other seasons are compared as
usual.

**Sync review** opens from the notification button with a count in the top bar, which counts the
films and shows waiting for a decision and is gone when there are none. When films are out of sync
as the app opens, or a show has been merged since the last message, a message says so a few seconds
later with a **Review** button; it stays until you use it or close it. It comes back at each launch
while a film is waiting; a show is announced once, at the first launch after a sync added it, and
then waits in the panel. Each profile on this computer keeps its own record of what it was told.

The panel has a **Shows** section and a **Films out of sync with Simkl** section. Each merged show
is a line for **Here** and one for each service involved, showing what that side had before the
merge, with a bubble per season: green when every episode is watched, blue with the last episode
reached when some are, grey when none are. A season still airing stays blue until its last episode
is watched. A season that cannot be sent to a service (an anime season with no matching entry
there, or any anime at Trakt) is drawn dashed on that service's line; hover a bubble for the count.
Specials have no bubble, but a series' specials are compared like any other episode: a row can
differ only in a special, and **Use** still sends or removes it. An anime's specials are not
compared. To settle a show:

- **Use** beside **Here**: every side goes back to what was here; what came in from the services is
  removed here and at the services.
- **Use** beside a service: this app is made to match it; the other service is sent what it had and
  keeps anything it recorded itself.
- **x**: keeps the merge as it is.

Each film in **Films out of sync with Simkl** shows Here and Simkl as Watched or Not watched. **Use
Local** sends this app's value to Simkl and then Trakt, **Use Simkl** rewrites the record here to
match Simkl and, with Trakt connected too, makes Trakt match it as well, and **x** stops asking
about that film; it can appear again once 90 days pass with no film ignored. A film saved under an
id only this app knows shows **Can't push** instead of Use Local; Use Simkl is the way to settle it.

The phone and TV app take in only what Simkl holds and have no such panel. The rules are in
[docs/WATCHLIST-SYNC.md](docs/WATCHLIST-SYNC.md#episodes-show-by-show).

**Your library** (Control centre → General) holds imports and backups:

- **Bring an existing history in**: IMDb's ratings export (needs nothing) and a Letterboxd "Export
  Your Data" zip (needs TMDB connected, to match titles; without it the row offers **Set up TMDB key**). Both only fill in what is missing.
  Imported viewings keep the dates you watched them; imported ratings keep the score but not the
  date.
- **Trakt history.** A connected Trakt account imports from **Accounts**, or by itself the first
  time its history is pulled. After that, what you watch on Trakt comes in by itself, but only
  viewings dated within three days of the last check; one added on Trakt with an older date, such as
  one marked as watched on its release date, stays there until you press **Import my Trakt library**
  again. **Import my Trakt library** skips a viewing already held here, as the first pull does, so
  pressing it again does not turn what you played here into a second play (see
  [docs/WATCHLIST-SYNC.md](docs/WATCHLIST-SYNC.md#trakts-history)).
- **Back up your library** to a single file and restore it on another machine, from the same card. A
  restore replaces the whole library on this machine, every profile's, with what the file holds
  rather than merging: anything watched, rated or listed here since the backup was taken is gone.
  The file also carries each profile's Collections page, the Trakt lists you added and the
  collections you took off, and a restore puts those back as they were; a backup file without them,
  from an older version, leaves this machine's Collections page as it is. The library it replaces is
  saved first as an automatic backup (below), so a restore from the wrong file can be undone.
  Service credentials stay on the machine that holds them.

### 6. Together — Watch Party needs nothing on a LAN; Rooms need a relay

Two different things, deliberately:

- **A Watch Party** is a temporary group watching one title in sync. Open **Rooms** in the top bar
  (it reads **Party** while one is live) and **Start a Watch Party**. Hosting always listens on your
  network directly and tries to map a router port; if an [R3 Party
  Sync](party-sync-worker/README.md) relay is connected it attaches to that too, and the single
  invite carries every route. Guests chat, and play, pause and seek are synchronized. By default
  only the host controls playback; **Everyone can play, pause and seek** hands those controls to
  guests. The host's app enforces it: while it is off, a guest's play, pause or seek reaches no one,
  even from an older version. The same switch, with the same name, is in the player's party rail,
  so the host can hand over control mid-film; guests see there whether they can.
  Each guest plays the title from their own sources, so each needs a copy they can reach: in their
  own cache, on a paired r3-cache server, or through TorBox or Jellyfin. A party can also start
  partway through a film: the player's party rail has its own **Start a Watch Party**, the party is
  born knowing the title and the live playhead, and guests land where you are rather than at the
  start. While you host, the rail shows the party's invite code with **Copy**, however the party was
  started. The **Party** panel in the main window shows a party started from the rail too, with its
  own **Invite** button and a line saying whether the invite works beyond your network, and keeps
  both after you close the player.
- **A Room** is a standing group: the family, the film friends. Creating one needs the relay (until
  it is connected, Rooms offers **Set up** in its place); joining with someone's room code does not. You see who is around and, per room and only if you
  turn on **Share what I'm watching here**, what they are watching. Then choose, each time, whether
  to **Join them** or start the same title on your own. Joining someone who is not hosting yet makes
  their app start a Watch Party around what it is playing, without asking them; they see a note that
  you are joining. That happens only in a room where they share what they are watching; if they have
  turned that off, the request is turned down and you see "They aren't sharing what they watch in
  this room." The creator is the room's admin and can rename it or remove members. Nobody hosts a
  room, so it survives anyone going offline.
- Every party and room message is encrypted end to end before it leaves the device; the relay
  forwards ciphertext. With a paired r3-cache on the LAN, the household shares one relay connection
  per room instead of one per device.

### 7. Operate — the control centre

The gear icon in the top bar (and the **Control centre** button on the Settings page) flips the app
over to its second face. It is where the installation is configured and watched. A control that
needs a service you have not set up says so in its place, with a **Set up** button that opens the
control centre at that service:

| Section           | What is there                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Pipeline**      | How a title gets from you asking for it to it playing, with every service drawn where it sits and whether it is live.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Services**      | What each connected service is doing now: qBittorrent's torrents (pause, resume, remove and keep the files, or delete with files), how many items Sonarr and Radarr each have queued, how many Prowlarr indexers are failing, Bazarr's status, and the app's own background work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Caching**       | The r3-cache server: a few seconds after launch the app looks for one on your network and asks to join it by itself, with a note when it finds it, joins, waits to be let in or follows it to a new address (or type its address and ask to join; **Leave** stops the automatic join until you ask again). Claim it as administrator (and close a `--claim-admin` window you no longer need), approve devices (a new request also shows as a note with **Allow** and **Deny** within about 20 seconds, plus a desktop notification when the app is not in front; one you dismiss stays here) and set their allocations, see how full it is, whether your TorBox key is saved there (**Save my key here** when it is not; with no TorBox key in this app nothing is sent, and **Set up TorBox** shows instead) and what is queued (cancelling a queued or fetching job), and what you have cached with a private/shared switch per title. Also what this device has cached, and **Forget wrong-copy marks** while any episode has a copy marked wrong. |
| **Updates**       | The build you are on, the **Stable** or **Preview** channel, a download progress bar, and what the offered version changes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **General**       | Display preferences, notifications, Performance & Display (Anime4K, video scaling, buffer, gauges), Your library (backup, imports).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Playback**      | Episodes, subtitles and languages, Network (limits, Where to play from, speed test), Storage while playing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Media servers** | TorBox (connect with its API token), and Jellyfin, Sonarr, Radarr, qBittorrent, Prowlarr and Bazarr, each with a connection test.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Accounts**      | Tracking (Simkl, Trakt, MyAnimeList), Artwork & metadata (TMDB, OMDb), Subtitles (SubDL, OpenSubtitles).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **AI**            | The local Ollama model behind the assistant and Recommend Next.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Community**     | The Watch Party relay, and profiles.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

- **A backup is taken automatically** into the `backups` folder in the app's data folder
  (`%APPDATA%\r3v07v3r-media-hub\backups` on Windows) before anything rewrites watch history on its
  own: an anime regroup or repair that moves rows held here, a Trakt import, the MyAnimeList apply,
  a restore, and, at most once a day each, the Trakt pull and the desktop's episode comparison
  (before it takes in a Trakt account's episodes, or before a **Sync review** choice removes
  episodes here). Simkl's take-in writes none.
- **Keeping one.** Each file is named `auto-`, the UTC time and what it preceded, for example
  `auto-2026-10-11T12-34-56-789Z-trakt-pull.json`. The newest five are kept, and the newest of each
  of those seven kinds on top, so the one taken before a rare step stays until that step runs again;
  copy one elsewhere or rename it without the `auto-` prefix to keep it.
  Restore it from **Your library** (**Restore…** does not open in that folder, so browse to it).
- **Ask Sonarr or Radarr for a title** straight from its page, picking the quality profile and
  folder, with a search starting as soon as it is added. Movies and series only; anime is
  catalogued by Kitsu id, which neither service can look up.
- **Search and ask in one field.** Press Enter in the top bar and it searches the movie, series and
  anime catalogs together and shows real titles you can open. With a local model connected its
  answer appears underneath: what the top result is, whether it fits what you have watched, and
  other titles worth trying. On the Movies, Series or Anime page the same field searches only that
  kind and shows the matches in place of the page.
- **When the online catalog is slow or away.** Every search asks the library on this device and the
  online catalog (Cinemeta, or Kitsu for anime) at once. With matches in the library the catalog
  gets about four seconds and a slower answer is left out; with none, the search waits for it, which
  on a slow link can take ten seconds or more. When the catalog is left out, the results say so, and
  on the Movies, Series and Anime pages and in the phone and TV app they say whether it did not
  answer in time or could not be reached. A later anime season left out of the Anime library is
  found by its own name too, from the library on this device, so that works offline; the result is
  the show it belongs to, not the season on its own.
- **Run the AI locally.** The assistant and the Recommend Next buttons use an
  [Ollama](https://ollama.com) model on your own machine; nothing is sent to a hosted service. An
  Ollama at its usual `http://127.0.0.1:11434` is found on its own. Without one the search still
  answers and the assistant says plainly that no model is connected. Home shows the Recommend Next
  buttons only while a model answers, and a one-line note with **Set up Ollama** otherwise; start
  Ollama later and they appear within about a minute, or as soon as you come back to the window,
  without restarting the app. If the model declines or replies with a title that was not on offer,
  the app picks one at random and says so.
- **Stay updated on your own terms.** Packaged builds check GitHub Releases a few times a day; an
  update downloads in the background and installs when you restart.
- **Link a phone.** **Control centre → Media servers → Link a phone** shows a one-time QR code. The
  phone app scans it and is signed in to the same services: TorBox, Simkl, the TMDB, OMDb and SubDL
  keys, the OpenSubtitles login, your subtitle and audio languages, age-rating region, Watch Party
  name and update channel ([android/README.md](android/README.md#updates) has the one exception).
  Trakt, MyAnimeList, the r3-cache device token and your room identity stay on the desktop. The code
  carries a one-time ticket rather than the secrets, is served once, and stops after three minutes.
  The phone must be on the same local network as the computer; if Windows asks whether to allow R3
  Media Hub on private networks, allow it, or the phone cannot connect. When linking moves the phone
  to a different update channel, the phone says so as it finishes, for example that it now follows
  Stable once a stable release is out.
- **Phone and desktop meet at Simkl.** Each time the phone app opens, comes back to the front or is
  linked, it brings its My List and watch history up to date from Simkl, never from the desktop, and
  what you watch on the phone reaches the desktop the same way. Without Simkl connected, nothing
  passes between the two. What the phone's Home shows is in
  [android/README.md](android/README.md#home-and-your-lists).

## Quick start

### Install a release

Download the Windows installer (NSIS setup executable) from the
[GitHub Releases page](https://github.com/r3v07v3r/r3v07v3r-media-hub/releases). Every push to
`preview` publishes a **Preview** build; promoting one to **Stable** is a manual step, and the
channel is yours to pick under **Control centre → Updates**.

The installer is per-machine, so Windows asks for elevation, and the install folder is fixed. The
app keeps its settings, database (`media-hub.sqlite`) and log (`logs/media-hub.log`) under
`%APPDATA%\r3v07v3r-media-hub`; the log starts a fresh file once it passes 5 MB and keeps the
previous one as `logs/media-hub.log.1`, so it never takes more than about 10 MB. Include both files
in a bug report: the lines just before a problem may be in the older one.

Every release also carries `r3-media-hub-android.apk`, one build for phones and Android TV. It is
signed with a debug key until a release key is added to the repository secrets, so treat it as a
build for test devices until then; see [android/README.md](android/README.md).

macOS and Linux packages are configured in `electron-builder.yml` but are not published: the release
workflow builds Windows only, and the bundled mpv player is fetched for Windows only. Building for
another platform from source needs an mpv you supply through `MPV_PATH`, and macOS also needs Apple
signing credentials because notarization is switched on.

### First run

A fresh install walks through a short welcome: your name (it is also what Rooms and Watch Parties
show to others), a playback source (**Connect TorBox**, **Connect a media server**, or **Not right
now**), whether video may be cached to disk, and, if so, a quick network and disk check that
suggests a quality cap, a size cap and a cache size. Everything it sets is changeable later.

1. If you skipped the source step, open the control centre (gear icon), choose **Media servers**,
   and connect **TorBox** (paste the API token from your TorBox account) or **Jellyfin** (switch the
   card on, enter the server URL and API key, then **Test connection** and **Save changes**).
2. Optional: under **Control centre → Playback**, choose your preferred audio and subtitle
   languages and connect a subtitle service under **Accounts**.
3. Open **Movies**, **Series**, or **Anime**, select a title, and press **Play**. It reads
   **Resume** once you have started, and for a show it names the next episode (for example
   **Play S1 E1**). To watch a different episode, pick it from the episode list on the title page.
4. R3 Media Hub remembers playback progress, so you can continue from Home.

```text
Control centre → Connect TorBox OR Jellyfin
                       ↓
Movies / Series / Anime / For You → Title page → Play → own cache → r3-cache → Jellyfin → TorBox
                       ↓                                     ↓
                    My Stuff                          Continue Watching
```

## Using the app

| Destination     | What you will find there                                                                                                                                                                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Home**        | The two Recommend Next quick picks (only while a local Ollama model answers; otherwise a **Set up Ollama** note), featured picks, continue watching, one row with a **Recommended For You** tab and, once you have planned something, a **Planned** tab (each with its own See all), optional system-performance gauges, and the mood tray. |
| **For You**     | The recommendation ranking shelved by why each title was picked. The top picks in order are Home's row, so they are not repeated here.                                                                                                                                                                                                      |
| **Movies**      | Movie discovery and filtering. Select a card for its synopsis, ratings, related titles, and playback actions.                                                                                                                                                                                                                               |
| **Series**      | TV discovery plus season and episode selection.                                                                                                                                                                                                                                                                                             |
| **Anime**       | Anime discovery, franchise groupings, episode progress, and anime-specific tracking.                                                                                                                                                                                                                                                        |
| **Collections** | Whole film-and-series universes from first to last, with how far through each you are, plus any public Trakt list you add.                                                                                                                                                                                                                  |
| **My Stuff**    | Seven tabs: Planned, Watched, Lists, Rated, History, Stats, Not for me.                                                                                                                                                                                                                                                                     |
| **Calendar**    | Episodes airing for what you follow: is there anything on tonight?                                                                                                                                                                                                                                                                          |
| **Settings**    | The few things you change while watching: next-episode autoplay, subtitle and audio language, browsing defaults, About & Updates, and a button into the control centre.                                                                                                                                                                     |

On desktop, press <kbd>Ctrl</kbd>+<kbd>B</kbd> (or <kbd>⌘</kbd>+<kbd>B</kbd> on macOS) to collapse
or expand the sidebar. On narrow windows, primary navigation moves to the bottom; use **More** for
For You, Collections, Calendar and Settings.

### Every service, and whether you need it

Playing anything that is not already cached requires **TorBox** or **Jellyfin**. Everything else is
optional. All of these are set up in the control centre; API credentials are entered in the app,
never in the source tree.

| Service             | Required?                                            | What it adds                                                                                                                                                                                  | Where                              |
| ------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| **TorBox**          | One of the two play sources                          | Streams any title TorBox has cached; submits the best release when it has not, or a release in your audio language when the cached ones lack it.                                              | Media servers, or the welcome flow |
| **Jellyfin**        | One of the two play sources                          | Plays from your own library over the LAN, ranked against TorBox by **Where to play from**.                                                                                                    | Media servers, or the welcome flow |
| **r3-cache**        | No                                                   | Pre-fetches what you plan to watch onto a LAN box and serves it in one hop. See [daemon/README.md](daemon/README.md).                                                                         | Caching                            |
| **Sonarr / Radarr** | No                                                   | Request a series or film from its page; see how many items each has queued.                                                                                                                   | Media servers                      |
| **qBittorrent**     | No                                                   | See, pause, resume or remove torrents, keeping or deleting their files. Not a playback source.                                                                                                | Media servers                      |
| **Prowlarr**        | No                                                   | A count of indexers in a failure backoff. Does not feed discovery.                                                                                                                            | Media servers                      |
| **Bazarr**          | No                                                   | Connection status only.                                                                                                                                                                       | Media servers                      |
| **TMDB**            | No (Letterboxd import needs it)                      | Age certificates, cast and crew, collections, better similar titles, grouped-anime episodes.                                                                                                  | Accounts → Artwork & metadata      |
| **OMDb**            | No                                                   | Rotten Tomatoes scores.                                                                                                                                                                       | Accounts → Artwork & metadata      |
| **Simkl**           | No                                                   | History push (scrobbles if turned on) and take-in of what was watched elsewhere, two-way watchlist (anime comes in only), your Simkl lists, Sync review.                                      | Accounts → Tracking                |
| **Trakt**           | No                                                   | History, ratings and (if turned on) scrobble push; two-way watchlist (films and series); lists pull; one-off import, then history pull; public lists as Collections (needs only the app key). | Accounts → Tracking                |
| **MyAnimeList**     | No                                                   | Anime progress push, two-way watchlist, preview-then-apply sync.                                                                                                                              | Accounts → Tracking                |
| **SubtitleDB**      | No (nothing to set up)                               | Built-in subtitle search and download, no account; the provider every install has.                                                                                                            |
| **SubDL**           | No                                                   | A second subtitle catalogue with no daily download limit.                                                                                                                                     | Accounts → Subtitles               |
| **OpenSubtitles**   | No                                                   | A second subtitle catalogue with hash matching (a free account allows 5 downloads a day).                                                                                                     | Accounts → Subtitles               |
| **R3 Party Sync**   | To create a Room; not to join one or for a LAN party | Relays Watch Party traffic across the internet; the backbone Rooms run on. See [party-sync-worker/README.md](party-sync-worker/README.md).                                                    | Community → Watch Party relay      |
| **Ollama**          | No                                                   | The assistant and Recommend Next, on a model you host. Found automatically on this machine.                                                                                                   | AI                                 |

Used automatically, with nothing to configure: Cinemeta, Kitsu and Simkl's public trending feed for
the catalog; AniList for anime franchises and air dates; Aniskip for anime skip times; the Torrentio
and Comet add-ons for release discovery; GitHub Releases for updates and the Anime4K pack; router
UPnP/NAT-PMP when hosting a party.

## Run from source

### Requirements

- [Node.js](https://nodejs.org/) 22.13 or newer. The database uses Node's built-in `node:sqlite`,
  which needs no flag from 22.13 on; CI runs on Node 22.
- npm (included with Node.js) and Git.
- Windows, for playback: `npm install` downloads the mpv player (an archive of about 30 MB that
  unpacks to over 100 MB) in its `postinstall` step for Windows only. The build is pinned by tag,
  file name and sha256 in `scripts/fetch-mpv.ts`. Its maker deletes old builds after about a month,
  so every pinned archive is also kept on this repository's `mpv-mirror` release, a prerelease that
  is never offered as an app update. The script tries that copy first and the upstream build second,
  and refuses either one if the hash does not match. To move to a newer mpv, run the **mpv re-pin**
  workflow from the Actions tab (it takes an upstream build date, or `latest`): it copies the archive
  to the mirror, keeps the older ones, and opens a PR that changes the pin. The release itself was
  created once by hand, right before an app release: a stable install switched to the preview
  channel reads the newest release in the feed, so the mirror must never be the newest for long,
  and the workflow refuses to create it. On other platforms set `MPV_PATH` to an installed mpv.

```bash
git clone https://github.com/r3v07v3r/r3v07v3r-media-hub.git
cd r3v07v3r-media-hub
npm install
npm run dev
```

`npm run dev` and `npm start` first run `scripts/ensure-electron.mjs`, which checks that the
Electron binary is in place (`node_modules/electron/path.txt`) and, if it is not, fetches it with
the electron package's own `install.js`; a failed fetch stops there with the reason. On the Electron
this repository pins, `npm install` does not fetch the binary, so this step is what fetches it on a
fresh install, and after `npm ci --ignore-scripts`. With `ELECTRON_EXEC_PATH` set to a binary kept
elsewhere (electron-vite's own setting), nothing is fetched.

### Environment variables

The desktop app reads one: `MPV_PATH`, the path to an mpv binary, which is also the only way to get
a player on macOS or Linux when running from source. The headless backend is configured entirely by
environment: `R3_USER_DATA` (settings, database, logs and automatic backups; required),
`R3_SITE_DIR` (the `build:web` output to serve; required), `R3_BRIDGE_PORT` (loopback port; the OS
picks one if unset), `R3_MASTER_KEY` (32 bytes, base64, sealing stored credentials), `R3_LOCALE`,
`R3_STOP_ON_STDIN_CLOSE=1` for a host that owns the process, and `R3_HOST_PLAYER=1` for a host that
shows the video itself (the Android app's libmpv), so the backend starts no mpv and opens no
controls window. The version is stamped in from `package.json` when `npm run build:headless` bundles
it. The daemon's variables are in [daemon/README.md](daemon/README.md).

### Project commands

| Command                    | Purpose                                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`              | Start Electron with the Vite development server and hot reload.                                                                 |
| `npm start`                | Preview an already-built application.                                                                                           |
| `npm test`                 | Run every registered test file (plain `tsx` scripts chained in `package.json`).                                                 |
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

The universes on the Collections page are a list kept by hand in `scripts/build-universes.mjs`,
which also holds each one's story order. Run `node scripts/build-universes.mjs` after editing it: it
checks every title against Cinemeta and rewrites `src/shared/media-hub/universeData.ts`, and writes
nothing if an id is missing, names a different title or points at an episode that does not exist. It
needs a network connection.

The `ai:*` scripts belong to an experimental review loop described in
[.ai/README.md](.ai/README.md); it has never been run in this repository.

### Architecture

```text
src/
├── main/                 Electron main process
│   ├── index.ts          Windows, the app protocol, the updater; calls backend.ts
│   ├── backend.ts        The service layer's startup and teardown, shared with headless/
│   ├── ipc/              Validated IPC endpoints (settings, HTTP proxy, telemetry, media hub)
│   └── media-hub/        Catalog, playback, stream cache, services, tracking, parties, rooms
├── preload/              Renderer-to-main bridge: window.api only
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
cache, and party networking run in the main process and are exposed through the preload bridge. The
preload exposes only `window.api`, a typed surface over the app's own channels; the page gets no raw
`ipcRenderer`, and every media-hub handler also refuses a caller from outside the app's own pages.
On Windows the video is not drawn by Chromium: mpv runs as a native child window embedded in the
app's own window, kept sized and stacked over the interface, with the player controls in a
transparent overlay window. Credentials live in two stores on purpose: Jellyfin and the download
stack in the app's settings store, everything else in the media-hub settings file; both are
encrypted with one app key (AES-256-GCM), which the operating system's key store (DPAPI on Windows,
the Keychain on macOS, the system keyring on Linux) seals in `media-hub-secret.key` beside the
settings, so the settings copied to another machine or Windows account are useless.

Four optional companions ship from this repository. [`daemon/`](daemon/README.md) is the r3-cache
LAN pre-fetch server. [`party-sync-worker/`](party-sync-worker/README.md) is the Watch Party relay
you deploy yourself. `src/headless/` with `npm run build:web` is the same app built to run without
Electron; playback in that build needs an mpv it can find: `MPV_PATH`, the copy `npm install`
fetches into `resources/mpv-win` on Windows, or a standard Windows install.
[`android/`](android/README.md) is one APK for phones and Android TV: the headless backend run on
the device behind a small separate interface (`src/app-ui`, `npm run build:app`), with libmpv as the
player. Its player has fewer controls than the desktop's, and it cannot host or join a Watch Party;
see [android/README.md](android/README.md#known-limitations). How it shares a list and history with
the desktop is under [Phone and desktop meet at Simkl](#7-operate--the-control-centre).

### What CI checks

`.github/workflows/verify.yml` runs on every pull request and gates every release: lint,
`npm run build` (both typechecks plus the bundle), `npm run typecheck:daemon`, `npm test`, a
production dependency audit, the web bundle booted with no backend under the real CSP, the headless
backend built and driven end to end in a browser, and the relay typechecked and dry-run deployed. A
separate workflow builds the Android APK for any pull request that touches `src/` or `android/`. Run
the same set before opening a pull request:

```bash
# App checks
npm run lint
npm run build
npm run typecheck:daemon
npm test
npm audit --omit=dev --audit-level=critical
# Web bundle and headless backend
npm run build:web
npx playwright install --with-deps chromium
npx tsx tests/webBundle.e2e.ts
npm run build:headless
npx tsx tests/headlessApp.e2e.ts
# Party relay
npm ci --prefix party-sync-worker
npm run typecheck --prefix party-sync-worker
(cd party-sync-worker && npx wrangler deploy --dry-run)
npm audit --prefix party-sync-worker --omit=dev --audit-level=critical
```

## Troubleshooting

<details>
<summary><strong>The catalog opens, but a title will not play</strong></summary>

Confirm that TorBox or Jellyfin is connected: open the control centre, **Media servers**, and check
that the TorBox card says **Connected** (reconnect if the token was revoked; a rejected token
disconnects it and tells you) or that the Jellyfin card is switched on and its **Test connection**
succeeds. Sonarr, Radarr and qBittorrent are not playback sources.

If a title plays but not from where you expected, check **Control centre → Playback → Where to play
from** and the quality limits beside it. A TorBox, r3-cache or Jellyfin release is only a candidate
if it is within the maximum resolution and size you set; a copy already on this machine is checked
against the resolution limit only.

</details>

<details>
<summary><strong>Home has no suggestions, or keeps old ones, and offers Retry</strong></summary>

No movie, series or anime catalog could be reached, and there was no saved list of suggestions to
fall back on. Continue Watching and the Planned tab still show, from the library on this device, and
suggestions already on screen stay. Press **Retry**, or wait for the connection to come back.

</details>

<details>
<summary><strong>The picture froze, or the player closed with "The player stopped responding"</strong></summary>

What the app does when the player hangs is under
[Play](#3-play--needs-mpv-bundled-with-the-windows-installer). In `logs/media-hub.log`, an
`mpv:stderr` line saying `mpv has not answered "<command>"` marks the hang, and the
`media-hub:player` line after it says whether the title was reloaded or given up on.

</details>

<details>
<summary><strong>Subtitles do not appear automatically</strong></summary>

Both automatic steps follow **Show subtitles automatically** on the Settings page. While it is on, a
track in the subtitle language chosen there is turned on by itself, and when the copy that plays has
no such track, one is fetched online by itself, whatever its audio, unless you pick one first; a
message names the language and the service it came from. SubtitleDB is searched without any setup;
SubDL and OpenSubtitles join when connected under **Control centre → Accounts → Subtitles**, and
each fetch from OpenSubtitles counts against its daily downloads. While the switch is off, nothing is fetched, and a track in your subtitle
language is turned on only when the copy lacks your audio language; with your audio language, the
player alone decides whether one shows. A subtitle you pick yourself in the player's Subtitles menu
always wins; otherwise open that menu and pick a result.

If neither service is connected, the menu says so. If every connected service fails (a bad key, an
outage, a rate limit), the menu shows each service's reason. With both connected and only one
failing, the menu shows the other's results, or **No results**, and the failure is written only to
`logs/media-hub.log`. Otherwise **No results** means the search found nothing for this title in your
language, so try another language.

</details>

<details>
<summary><strong>The AI assistant says no model is connected</strong></summary>

The AI features only ever talk to an [Ollama](https://ollama.com) you run yourself. Install it and
pull a model (`ollama pull llama3.2`); running at `http://127.0.0.1:11434` on this machine it is
found on its own, even if started after the app. A missing or stopped Ollama shows on Home as a
note with **Set up Ollama** where the Recommend Next buttons would be.

Open **Control centre → AI** for the cases that are not automatic: a server on another machine, a
different port, or a specific model. Enter the address, press **Check** to list what is installed,
pick a model and press **Connect**. **Disconnect** turns the AI features off, including the
automatic look, until you connect again. For an Ollama on another machine, that machine must have
`OLLAMA_HOST` set to something other than localhost to accept network connections at all.

</details>

<details>
<summary><strong>A Watch Party guest cannot connect</strong></summary>

On the same LAN, check that the firewall allows the app. Across the internet, hosting depends on
your router: either the automatic port mapping succeeded, or an R3 Party Sync relay was connected
under **Control centre → Community → Watch Party relay** when you hosted. The party listens on a new
port each time it is hosted and the app does not show it, so a port forwarded by hand on the router
does not help. The host's Party panel says **Invite works across the internet** or **Local network
only**; for the second, connect R3 Party Sync under **Control centre → Community → Watch Party
relay** and host again. With the relay connected there is nothing to switch: the invite carries the
relay route and each guest's app uses the first route that answers.

</details>

<details>
<summary><strong>A media-server connection test fails</strong></summary>

Check the server URL, credentials or API key, and whether the server is reachable from this machine.
Use the full base URL, including `http://` or `https://` and a non-default port when needed.

</details>

<details>
<summary><strong>Series show no episodes, or the catalog is empty, behind a DNS filter</strong></summary>

Some filtering DNS resolvers block `v3-cinemeta.strem.io`. The app then turns to Cinemeta's second
host by itself, and the log says `cinemeta:fallback-host` once. If both are blocked, a title opens
without its episode list (logged as `meta:primary`) and the app looks again after ten minutes. Allow
`*.strem.io` in the filter.

</details>

<details>
<summary><strong>A watch mark did not reach Simkl, Trakt or MyAnimeList</strong></summary>

The Watchlists panel (**Control centre → Accounts → Tracking**) shows how many titles still have
watched changes owed, and to which services. When they are sent again and when they are given up is
under [Sync](#5-sync--optional-one-account-per-service).

The log (`logs/media-hub.log` under `%APPDATA%\r3v07v3r-media-hub`) has a line for each change given
up on (`history:push-abandoned`) or that a service can no longer take (`history:push-dropped`). It
also records each episode merge that added or sent something (`episode-sync`), each time the films
review sends or settles something (`reconcile:flush`), each automatic backup written or failed
(`backup:auto`; one skipped because a recent backup exists leaves no line), and each anime row a
regroup or the one-time anime repair left where it was (`anime:regroup`, `anime:sync-repair`). A
`sync-repair` line says whether the row waits on a TheTVDB lookup, which the repair tries again at
the next launch, or was left for good because its season could not be confirmed. Lines carry no
level, so a routine record looks the same as an error: read the message.

</details>

<details>
<summary><strong>Something watched elsewhere did not show up here</strong></summary>

The desktop takes in what was watched at Simkl when its window opens and when it comes back to the
front (at most every ten minutes, and not while something is playing); Trakt's history comes in then
too, and every half hour. Both only add. Anime from Simkl waits until the anime catalog has been
grouped, and after a failure Simkl is asked again after a pause that grows with each failure, up to
six hours. An older Trakt viewing is covered under **Trakt history** in
[Sync](#5-sync--optional-one-account-per-service).

In `logs/media-hub.log`, `catch-up:activities` means Simkl could not be asked what changed, and
`catch-up`, `catch-up:planned` and the `catch-up:library:`, `catch-up:write:` and `catch-up:state:`
lines name a read or a write that failed. The Trakt pull logs under `trakt:pull` ("Stopped at the
page limit." means it did not read the whole history), `catch-up:trakt` and `job:trakt-history`,
and the half-hourly watchlist pull under `job:planned-sync`.

</details>

## Security and privacy

- Keep API keys, account credentials, and party invitations private; never commit them.
- Prefer HTTPS for remote service connections.
- Know what the app talks to. Without any account it contacts Cinemeta (`v3-cinemeta.strem.io`, and
  `cinemeta-live.strem.io` or `cinemeta-catalogs.strem.io` only when the first cannot be reached),
  Simkl's public feed (`data.simkl.in`), Kitsu (`kitsu.io`), AniList (`graphql.anilist.co`), Aniskip
  (`api.aniskip.com`), YouTube for trailers (`youtube-nocookie.com`, with the video from YouTube's
  and Google's media hosts), Cloudflare's speed-test endpoint when you run the connection test, and
  GitHub for updates and the Anime4K pack. Artwork loads straight from the image hosts the catalog
  names: `simkl.in`, `images.metahub.space`, Kitsu's media hosts, AniList's `s4.anilist.co`
  (for new anime whose Kitsu art is only an expiring link) and IMDb's `m.media-amazon.com`.
  The Torrentio (`torrentio.strem.fun`) and Comet (`cometfortheweebs.midnightignite.me`) add-ons are
  queried for releases when you play from TorBox, and every half hour while an r3-cache server is
  paired, for titles it should pre-fetch; only the title's id is sent, never your TorBox token.
  Neither is configurable. Every other host is one you connected yourself.
- The [security review playbook](docs/SECURITY_REVIEW.md) lists the manual checks worth running
  (renderer-to-main capability, the HTTP proxy, secrets, the packaged app, media processing) and
  the automated checks still to add.
- Each person's TorBox key is saved on the r3-cache server and used only for their own requests,
  never for anyone else's. The join the app makes by itself at launch saves it, and its note says
  so; asking to join by hand offers **Save my TorBox key on this server**, ticked by default. The
  key is kept there as plain text in the daemon's data directory (readable only by the daemon's
  user on Linux; on Windows only the user profile's permissions protect it). Changing the key in
  the app saves the new one there, and removing it removes it there. A device with no key saved
  cannot queue downloads (it still gets files already cached), and the app says so once. Leaving
  withdraws the key if the server answers at that moment; otherwise it stays there until the
  server's administrator removes your device.
- Tokens and API keys are only as recoverable as `media-hub-secret.key`. If the operating system can
  no longer open it (a reset key store, or a profile restored from another machine), the app sets it
  aside as `media-hub-secret.key.unreadable-<time>`, starts a new key, and every service shows as
  signed out until you enter its credentials again; only the log says why. Where the operating
  system has no key store, credentials are stored unencrypted. Credentials an older version saved
  are re-sealed under the key at the first launch, with nothing to do; an older version cannot read
  them afterwards, so going back to one means entering every credential again.
- Report security issues privately to the maintainer rather than in a public issue.

## Known limitations

- A partly downloaded title can only resume from the source it came from, so it still needs that
  source connected.
- Some sync changes are let go without a message: a mark, an un-mark, a Trakt rating or the Simkl
  copy of a MyAnimeList apply given up after ten refused tries or 30 days, and what is still waiting
  when a service is signed out or connected again (see
  [Sync](#5-sync--optional-one-account-per-service)).
- **Merged anime and the tracking services.** For a long entry that TMDB splits into several
  seasons, such as Naruto: Shippuden, its episodes taken in from Simkl, MyAnimeList or Trakt past
  the end of TMDB's first season do not show on the show's page; episodes marked on the page do.
  Without a TMDB key, fewer seasons are sent than could be. Anime episodes the catch-up or an import
  filed by a season's position in the group, rather than by the season it is, stay where they were
  filed: nothing tells them apart from episodes marked on the show's page. Without a TMDB key, a
  merged anime's seasons are its entries in order; if a key is added later, the show's page is
  numbered by TMDB's seasons instead, and episodes already marked stay under the season they were
  filed under (the log names each with `anime:regroup`).
- **Not yet tried against real accounts.** These parts of the sync follow each service's
  documentation and have only been run against stand-in servers: reading only what changed at Simkl
  and Trakt; sending anime to Simkl as one entry per season, a single-season anime included; which
  MyAnimeList entry a season of a merged anime is sent to, and where anime from MyAnimeList and
  Trakt is filed here; and the desktop's show-by-show episode comparison. If an anime episode you
  mark does not appear at Simkl, or appears on another season's entry, please report it.
- **Profiles.** A PIN is asked for only when you switch to that profile inside the app, so it is
  not a lock: the app reopens on whichever profile was last in use, and from another profile the
  PIN can be removed, or the profile deleted, without it. A **Kids** profile shows a badge next to
  its name and restricts nothing.

## License

R3 Media Hub is open source under the [MIT License](LICENSE): anyone may use, change and share it,
as long as the copyright notice stays with it. If you build on it, a mention of R3 Media Hub is
appreciated. The player, fonts and other components it ships or fetches keep their own licenses,
listed in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Contributing

Issues and focused pull requests are welcome. Pull requests target `preview`; every merge there
publishes a Preview build, and Stable is promoted by hand. Run the CI commands above before
submitting, keep credentials and generated build output out of commits, and let Prettier, ESLint and
TypeScript keep the style consistent.

---

<div align="center">
  Built with Electron, React, and TypeScript. Playback is <a href="https://mpv.io">mpv</a> (GPL),
  fetched at install time from shinchiro's Windows builds.
</div>
