# R3V07V3R Media Hub

Standalone Windows media client using TorBox as its account and playback backend. It does not connect to or depend on a personal media server.

## Windows application

- Per-machine NSIS installer to `Program Files\R3V07V3R Media Hub`
- Desktop and Start Menu shortcuts
- Mandatory first-run TorBox API-token onboarding
- Token verification against TorBox and Windows-encrypted local storage
- Local SQLite database in the signed-in user's application-data folder
- Cached live Movies and Series catalogs from Cinemeta
- Cached live Anime catalog and episode metadata from Anime Kitsu
- Local tracked list and watch history
- Home-page rows for new episodes from tracked shows
- Genre recommendations learned from locally watched titles
- Simkl PIN authentication, playback scrobbling, and watched-history sync
- TorBox stored-content list
- Keyless Meteor discovery followed by direct TorBox cache checking
- TorBox token is never embedded in Meteor URLs
- Automatic best cached stream selection and VLC playback

## Simkl setup

Simkl requires every client application to have a registered `client_id`. Create one at:

https://simkl.com/settings/developer/new/

Paste that client ID into **Simkl Sync** in the app, approve the PIN at `https://simkl.com/pin`, and the access token is encrypted locally. No client secret is used by the PIN flow.

## Development

```bash
npm install
npm test
npm start
npm run pack:win
```

The project is tracked in Git on the `main` branch. GitHub publishing requires GitHub authentication on the development PC.
