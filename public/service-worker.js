/* eslint-env serviceworker */

// public/service-worker.js
// Admin PWA Service Worker for My Progress Planner Admin Portal

const CACHE_VERSION = "admin-v1.0.0";
const CACHE_NAMES = {
  APP_SHELL: `admin-app-shell-${CACHE_VERSION}`,
  API_CACHE: `admin-api-cache-${CACHE_VERSION}`,
  IMAGES: `admin-images-${CACHE_VERSION}`,
  STATIC: `admin-static-${CACHE_VERSION}`,
};

// Critical admin app shell resources
const APP_SHELL_URLS = [
  "/",
  "/admin",
  "/manifest.json",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
  "/admin-icon.png", // Add your admin-specific icon if you have one
];

// Admin API endpoints caching strategies
const API_CACHE_PATTERNS = {
  CACHE_FIRST: [
    /\/api\/admin\/stats/, // Cache stats for offline viewing
    /\/api\/admin\/logs/, // Cache logs for offline analysis
  ],
  STALE_WHILE_REVALIDATE: [
    /\/api\/admin\/users/, // User data that updates frequently
    /\/api\/admin\/analytics/, // Analytics that change often
  ],
  NETWORK_FIRST: [
    /\/api\/admin\/send-push/, // Push notifications must be fresh
    /\/api\/admin\/auth/, // Authentication must be real-time
    /\/api\/admin\/settings/, // Settings changes need immediate sync
    /\/api\/admin\/user-actions/, // Any admin actions on user data
  ],
};

// Utility functions
function log(message, data = null) {
  console.log(`[Admin SW ${CACHE_VERSION}] ${message}`, data || "");
}

function isNavigationRequest(request) {
  return (
    request.mode === "navigate" ||
    (request.method === "GET" &&
      request.headers.get("accept")?.includes("text/html"))
  );
}

function shouldCacheRequest(request) {
  return (
    request.url.startsWith("http") &&
    !request.url.includes("chrome-extension") &&
    !request.url.includes("chrome://")
  );
}

function getApiCacheStrategy(url) {
  for (const [strategy, patterns] of Object.entries(API_CACHE_PATTERNS)) {
    if (patterns.some((pattern) => pattern.test(url))) {
      return strategy;
    }
  }
  return "NETWORK_FIRST"; // Default to network first for admin operations
}

// Cache management
async function cleanupOldCaches() {
  const cacheNames = await caches.keys();
  const currentCaches = Object.values(CACHE_NAMES);

  await Promise.all(
    cacheNames
      .filter(
        (cacheName) =>
          cacheName.includes("admin") && !currentCaches.includes(cacheName)
      )
      .map((cacheName) => {
        log(`Deleting old admin cache: ${cacheName}`);
        return caches.delete(cacheName);
      })
  );
}

// Install event
self.addEventListener("install", (event) => {
  log("Installing admin service worker");

  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAMES.APP_SHELL).then((cache) => {
        log("Caching admin app shell resources");
        return cache.addAll(APP_SHELL_URLS);
      }),
      cleanupOldCaches(),
    ])
  );

  self.skipWaiting();
});

// Activate event
self.addEventListener("activate", (event) => {
  log("Activating admin service worker");

  event.waitUntil(Promise.all([cleanupOldCaches(), self.clients.claim()]));
});

// Fetch event
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (!shouldCacheRequest(request)) {
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(handleNavigationRequest(request));
  } else if (url.pathname.startsWith("/api/")) {
    event.respondWith(handleApiRequest(request));
  } else if (request.destination === "image") {
    event.respondWith(handleImageRequest(request));
  } else {
    event.respondWith(handleStaticRequest(request));
  }
});

// Request handlers
async function handleNavigationRequest(request) {
  try {
    const cache = await caches.open(CACHE_NAMES.APP_SHELL);
    return (
      (await cache.match("/admin")) ||
      (await cache.match("/")) ||
      fetch(request)
    );
  } catch (error) {
    log("Navigation request failed", error);
    return new Response("Admin portal offline", {
      status: 503,
      headers: { "Content-Type": "text/html" },
      body: `
        <!DOCTYPE html>
        <html>
          <head><title>Admin Portal Offline</title></head>
          <body style="font-family: system-ui; text-align: center; padding: 2rem;">
            <h1>🔐 Admin Portal</h1>
            <p>Currently offline. Please check your connection.</p>
          </body>
        </html>
      `,
    });
  }
}

async function handleApiRequest(request) {
  const strategy = getApiCacheStrategy(request.url);
  const cache = await caches.open(CACHE_NAMES.API_CACHE);

  switch (strategy) {
    case "CACHE_FIRST":
      return handleCacheFirst(request, cache);
    case "STALE_WHILE_REVALIDATE":
      return handleStaleWhileRevalidate(request, cache);
    case "NETWORK_FIRST":
    default:
      return handleNetworkFirst(request, cache);
  }
}

async function handleCacheFirst(request, cache) {
  try {
    const cached = await cache.match(request);
    if (cached) return cached;

    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    return (
      cached ||
      new Response(
        JSON.stringify({
          error: "Admin data unavailable offline",
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
  }
}

async function handleStaleWhileRevalidate(request, cache) {
  const cached = await cache.match(request);
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => cached);

  return cached || fetchPromise;
}

async function handleNetworkFirst(request, cache) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      // Only cache successful admin responses for brief periods
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    const cached = await cache.match(request);
    return (
      cached ||
      new Response(
        JSON.stringify({
          error: "Admin operation failed - network required",
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }
      )
    );
  }
}

async function handleImageRequest(request) {
  const cache = await caches.open(CACHE_NAMES.IMAGES);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return new Response("Admin image offline", { status: 503 });
  }
}

async function handleStaticRequest(request) {
  const cache = await caches.open(CACHE_NAMES.STATIC);
  const cached = await cache.match(request);

  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return cached || new Response("Admin resource offline", { status: 503 });
  }
}

// Push notification handler for admin alerts
self.addEventListener("push", function (event) {
  const data = event.data?.json() || {};
  const title = data.title || "Admin Alert - Progress Planner";
  const options = {
    body: data.body || "New admin notification requiring attention 📊",
    icon: "/apple-touch-icon.png",
    badge: "/admin-badge.png", // Add admin-specific badge if you have one
    tag: "admin-notification", // Group admin notifications
    requireInteraction: true, // Keep notification until clicked
    data: {
      url: data.url || "/admin",
      type: "admin",
      timestamp: Date.now(),
    },
    actions: [
      {
        action: "view",
        title: "View Admin Portal",
        icon: "/admin-icon.png",
      },
      {
        action: "dismiss",
        title: "Dismiss",
        icon: "/close-icon.png",
      },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// Enhanced notification click handler for admin
self.addEventListener("notificationclick", function (event) {
  event.notification.close();

  const { action, data } = event;
  const url = data?.url || "/admin";

  if (action === "dismiss") {
    // Just close the notification
    return;
  }

  // Default action or 'view' action
  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      // Check if admin portal is already open
      for (const client of clients) {
        if (client.url.includes("/admin") && "focus" in client) {
          client.focus();
          if (url !== "/admin") {
            client.navigate(url);
          }
          return;
        }
      }

      // Open new admin portal window
      return self.clients.openWindow(url);
    })
  );
});

// Background sync for admin operations (if needed)
self.addEventListener("sync", (event) => {
  log(`Admin background sync: ${event.tag}`);

  if (event.tag === "admin-data-sync") {
    event.waitUntil(syncAdminData());
  }
});

async function syncAdminData() {
  try {
    log("Syncing admin data");
    // Implementation for syncing any pending admin operations
  } catch (error) {
    log("Admin data sync failed", error);
  }
}
