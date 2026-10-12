# Cruise

Plan a car cruise: the organiser draws a route on a real street map, drops stops along it, and shares a
link. Everyone who joins shows up live on the map. The screen is kept awake while the app is open.

No dependencies. Needs Node 18 or newer.

## Run it on your computer

    node server.js
    # open http://localhost:3000

GPS works on `localhost`. To try it on a phone you need HTTPS (browsers only allow GPS and
screen-wake on secure pages). Quick way: a tunnel.

    npx cloudflared tunnel --url http://localhost:3000     # or: ngrok http 3000

Open the https link it prints on your phone.

## Put it online (so friends can join)

Any host that runs Node and gives you HTTPS works. Easiest options:

- **Render**: New > Web Service > connect this folder from GitHub. Build command: leave empty.
  Start command: `node server.js`.
- **Railway** or **Fly.io**: deploy the folder (a Dockerfile is included).
- **Your own server**: `node server.js` behind Caddy or nginx for HTTPS.

Notes:
- Cruises are held in memory and forgotten after 48 hours idle. To keep routes across restarts, set
  `DATA_FILE=/some/persistent/path/cruises.json` (needs a persistent disk on the host).
- Run a single instance. Live state is in that one process.
- Free hosting tiers often sleep when idle, so the first open can take ~30 seconds.

## Install on a phone

Open the site, then:
- iPhone: Share > Add to Home Screen.
- Android: browser menu > Install app / Add to Home screen.

It then opens full screen like a normal app.

## Settings (public/config.js)

- `tileUrl`: map tiles. OpenStreetMap's own server is fine for testing and small groups; for a
  busy public app use a provider with a key (MapTiler, Stadia, Thunderforest) and paste its URL.
- `osrmUrl`: road snapping. The public demo server is for light use; host your own OSRM or use an
  OSRM-compatible service for heavy use. Turn "Roads" off in the app to draw straight lines.

## How it works

- `server.js`: serves `public/`, stores cruises, pushes route and car positions with Server-Sent Events.
- `public/app.js`: the app (Leaflet map, route drawing, live cars, wake lock).
- The organiser gets a secret key when they start a cruise (stored on their device). Only that key can
  change the route. Joiners can only watch and share their own position.
- Anyone with the code can join. There are no accounts.
