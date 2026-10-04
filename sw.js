const CACHE="aese-waterpolo-v21";
const CORE=[
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./assets/aese-waterpolo-hero-mixed.jpg",
  "./assets/aese-waterpolo-hero.webp",
  "./supabase-client.js",
  "./supabase-config.js",
  "./supabase-rosters.js"
];

self.addEventListener("install",event=>{
  event.waitUntil(
    caches.open(CACHE)
      .then(cache=>cache.addAll(CORE))
      .then(()=>self.skipWaiting())
  );
});

self.addEventListener("activate",event=>{
  event.waitUntil(
    caches.keys()
      .then(keys=>Promise.all(
        keys.filter(key=>key.startsWith("aese-waterpolo-")&&key!==CACHE)
          .map(key=>caches.delete(key))
      ))
      .then(()=>self.clients.claim())
      .then(()=>self.clients.matchAll({type:"window",includeUncontrolled:true}))
      .then(clients=>clients.forEach(client=>client.postMessage({type:"AESE_UPDATE_READY",version:CACHE})))
  );
});

function fetchWithTimeout(request,ms){
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),ms);
  return fetch(request,{signal:controller.signal}).finally(()=>clearTimeout(timer));
}

self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;

  const url=new URL(request.url);
  if(url.origin!==self.location.origin)return;

  event.respondWith(
    fetchWithTimeout(request,3000)
      .then(response=>{
        if(response&&response.ok){
          const copy=response.clone();
          caches.open(CACHE).then(cache=>cache.put(request,copy)).catch(()=>{});
        }
        return response;
      })
      .catch(()=>{
        return caches.match(request).then(cached=>{
          if(cached)return cached;
          if(request.mode==="navigate")return caches.match("./index.html");
          return Response.error();
        });
      })
  );
});
