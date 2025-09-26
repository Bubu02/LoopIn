// Simple app-shell cache so UI loads offline.
// Messaging still needs network.
const CACHE = "chat-app-v1";
const ASSETS = [
  "/", "/index.html", "/style.css", "/client.js",
  "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
  );
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  // Cache-first for static; network for others
  const isStatic = request.method === "GET" &&
    (request.destination === "document" ||
     request.destination === "script" ||
     request.destination === "style" ||
     request.destination === "image" ||
     request.url.includes("/manifest.webmanifest"));

  if (isStatic) {
    e.respondWith(
      caches.match(request).then(cached =>
        cached || fetch(request).then(resp => {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(request, copy));
          return resp;
        })
      )
    );
  }
});