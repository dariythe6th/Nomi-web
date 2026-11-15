const R = 6371000, rad = Math.PI / 180;
export const MAX_SPEED = 70; // m/s: server-side plausibility limit

export function dist(a, b) {
  const dLa = (b.lat - a.lat) * rad, dLo = (b.lon - a.lon) * rad;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Used by the server (authority) and by the client (replay after correction).
export function validateMove(prev, next, dtMs) {
  return dist(prev, next) / (Math.max(dtMs, 50) / 1000) <= MAX_SPEED;
}

// Geometric median (Weiszfeld): minimises total travel of all friends.
export function meetingPoint(pts) {
  let p = { lat: pts.reduce((s, q) => s + q.lat, 0) / pts.length, lon: pts.reduce((s, q) => s + q.lon, 0) / pts.length };
  for (let i = 0; i < 50; i++) {
    let x = 0, y = 0, w = 0;
    for (const q of pts) { const d = Math.max(dist(p, q), 1); x += q.lat / d; y += q.lon / d; w += 1 / d; }
    p = { lat: x / w, lon: y / w };
  }
  const ds = pts.map((q) => dist(p, q));
  return { point: p, dists: ds, total: ds.reduce((a, b) => a + b, 0), max: Math.max(...ds) };
}
