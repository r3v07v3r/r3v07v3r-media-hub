# R3V07V3R Media Hub

Standalone Windows media client using TorBox as its account and playback backend. It does not connect to or depend on a personal media server.

## Current Windows build

- Mandatory first-run TorBox API-token onboarding
- Token verification against TorBox and Windows-encrypted local storage
- Live Movies and Series catalogs from Cinemeta
- Live Anime catalog and episode metadata from Anime Kitsu
- TorBox stored-content list
- Meteor stream resolution using the connected TorBox account
- Automatic best playable cached stream selection
- Direct playback in VLC on Windows

## Development

```bash
npm install
npm test
npm start
npm run pack:win
```

The project is tracked in Git on the `main` branch. GitHub publishing requires GitHub authentication on the development PC.
