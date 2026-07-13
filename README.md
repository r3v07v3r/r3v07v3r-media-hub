# R3 Media Hub

Standalone Windows media client using TorBox as its account and playback backend. It does not connect to or depend on a personal media server.

## Windows application

- Per-machine NSIS installer with a stable upgrade identity
- Desktop and Start Menu shortcuts
- Mandatory first-run TorBox API-token onboarding
- Token verification against TorBox and Windows-encrypted local storage
- Local SQLite database in the signed-in user's application-data folder
- Broad catalogs with 500+ Movies, Series and Anime entries, progressive rendering, wanted/excluded genre filters, rating/year filters and sorting
- Five-title rotating feature banners for Movies and Series
- Visual season tabs, episode tiles, watched states and overall Series progress
- Cached live Anime catalog and episode metadata from Anime Kitsu
- Full-bleed feature backdrops, poster artwork and optional title logos
- In-app privacy-enhanced YouTube trailer playback
- Cinema full-screen mode from the header or `F11`
- Local tracked list and watch history
- Home-page rows for new episodes from tracked shows
- Genre recommendations learned from locally watched titles
- Simkl PIN authentication, in-app redirect-URI guidance with one-click copy, playback scrobbling, and watched-history sync
- Central Settings page for TorBox, Simkl, embedded playback status, and appearance
- Five persistent command-center themes: Neon Noir, Midnight Gold, Abyssal Ocean, Ember Protocol, and Ghost Terminal
- Sidebar profile block with connection state, R3 branding, and secure account logout
- Artwork-first TorBox library with cleaned release names, movie/episode detection, metadata matching and branded fallbacks
- Keyless Meteor discovery followed by direct TorBox cache checking
- TorBox token is never embedded in Meteor URLs
- Automatic best cached stream selection in an embedded player; unsupported codecs fall back to invisible VLC-to-WebM compatibility streaming on private loopback
- Private random-token playback proxy with byte-range support; TorBox download URLs are never exposed to the renderer
- Sandboxed renderer, strict navigation/permission controls, trusted external-link allowlist, SSRF-resistant playback URL validation, and hardened Electron runtime fuses
- Debounced local catalog filtering, progressive image loading/decoding, and reduced-motion-aware hero rotation
- Automatic GitHub Release update checks, background downloads and restart-to-install
- Tag-driven Windows release workflow in GitHub Actions

## Simkl setup

Simkl requires every client application to have a registered `client_id`. Create one at:

https://simkl.com/settings/developer/new/

Paste that client ID into **Settings → Simkl** in the app, approve the PIN at `https://simkl.com/pin`, and the access token is encrypted locally. No client secret is used by the PIN flow.

## Development

```bash
npm install
npm test
npm start
npm run pack:win
```

The project is tracked in Git on the `main` branch. GitHub publishing requires GitHub authentication on the development PC.
