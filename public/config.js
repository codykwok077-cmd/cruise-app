// Map + routing settings. Edit these to change providers.
window.CRUISE_CONFIG = {
  // OpenStreetMap's own tile server is fine for testing and small groups.
  // For a busy public app, switch to a provider with an API key (MapTiler, Stadia, Thunderforest...)
  // and put its URL here, e.g. 'https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=YOUR_KEY'
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '&copy; OpenStreetMap contributors',

  // Used to snap the drawn route to real roads. The public demo server is for light use only;
  // you can host your own OSRM or use any OSRM-compatible service.
  osrmUrl: 'https://router.project-osrm.org'
};
