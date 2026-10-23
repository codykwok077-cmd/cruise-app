// Map + routing settings. Edit these to change providers.
window.CRUISE_CONFIG = {
  // Main map: OpenFreeMap (free, no key needed, drawn by the phone). If it can't load, the app
  // automatically switches to the raster map below (tileUrl).
  vectorStyle: 'https://tiles.openfreemap.org/styles/liberty',
  vectorAttribution: '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> &copy; <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',

  // Backup map (used only if the main map fails). OpenStreetMap's own server is fine as a backup.
  // To use another provider as the backup (e.g. Stadia), paste its tile URL here.
  // For a busy public app, switch to a provider with an API key (MapTiler, Stadia, Thunderforest...)
  // and put its URL here, e.g. 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=YOUR_KEY'
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '&copy; OpenStreetMap contributors',

  // Used to snap the drawn route to real roads. The public demo server is for light use only;
  // you can host your own OSRM or use any OSRM-compatible service.
  osrmUrl: 'https://router.project-osrm.org',

  // Place search. OpenStreetMap's Nominatim is free for light use (about 1 search per second, and
  // the app only searches when you press Search). For heavy use, point this at a geocoder that
  // returns Nominatim-style results (your own Nominatim, LocationIQ, MapTiler, etc.).
  geocodeUrl: 'https://nominatim.openstreetmap.org/search'
};
