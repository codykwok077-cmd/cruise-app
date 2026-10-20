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
- Photos are held in server memory only (up to 80 per cruise, about 40 MB) and are lost when the server
  restarts or the cruise expires. Anyone with the cruise code can add photos; the organiser can remove them.
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
- `geocodeUrl`: place search (Nominatim-style). The public server is for light use only.
- `units`: `auto`, `metric` or `imperial` for voice and distances.
- `osrmUrl`: road snapping and turn directions. The public demo server is for light use; host your own OSRM or use an
  OSRM-compatible service for heavy use. Turn "Roads" off in the app to draw straight lines.

## How it works

- `server.js`: serves `public/`, stores cruises, pushes route and car positions with Server-Sent Events.
- `public/app.js`: the app (Leaflet map, route drawing, live cars, wake lock).
- **Place search**: the magnifier button opens a side drawer. Search for a place (cafe, beach, address),
  tap a result to see it on the map, and the organiser can add it as a stop or a route point.
- **Start route (voice guidance)**: anyone can press **Start route** to drive the route. It speaks turn
  instructions like a maps app ("In 500 metres, turn left onto Beach Road"), announces stops and the finish,
  shows the next turn, distance left and arrival time, follows you on the map, and recalculates if you leave
  the route. If you're away from the route it first guides you to the start. **Muted** turns the voice off.
  Turn directions come from the road-snapping service, so the organiser needs **Roads: On** when drawing.
  For a route drawn earlier, the organiser taps **Add turn directions for voice guidance** in the Route tab.
  Units follow the phone (miles in the US, otherwise km); set `units` in `public/config.js` to force one.
  Set it up before you drive, use a phone mount, and keep the phone volume up (voice plays like any other
  audio, so it normally comes through the car speakers if the phone is connected by Bluetooth or cable).
- **Always follows you while driving**: when you start a route, or whenever you're moving at about 18 km/h
  or faster, the map keeps your car centred (lower on screen during a route, so you see the road ahead).
  There's no switch for it. It stays on through traffic lights and stops about a minute after you stop
  moving, so you can pan the map freely when you're parked. Pinch to zoom and it keeps your zoom level.
- **Info**: the organiser sets the date, meet time, end time and details (parking, rules, what to bring).
  Everyone sees it live, and people who join a cruise with details set land on it first. Times are shown
  as entered (local time), so they suit a cruise where everyone is in the same area.
- **Photos**: everyone can add photos from the Photos tab ("Take photo" opens the camera, "Choose photos" opens the library). Photos taken just now are pinned on the map where
  they were taken. The person who added a photo can delete it, and so can the organiser.
- The organiser gets a secret key when they start a cruise (stored on their device). Only that key can
  change the route. Joiners can only watch and share their own position.
- Anyone with the code can join. There are no accounts.
