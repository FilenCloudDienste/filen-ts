/// <reference lib="webworker" />
declare const self: ServiceWorkerGlobalScope

import { SW_PROTOCOL_VERSION, SW_SKIP_WAITING_MESSAGE } from "@/lib/sw/protocol"

// Update policy: no skipWaiting at install — a new worker stays in "waiting" until the page confirms
// the update prompt (register.ts's applyUpdate posts this message), so activation never interrupts
// whatever the currently-controlling worker is already doing. Hence: no install handler at all.
self.addEventListener("message", (event: ExtendableMessageEvent) => {
	if ((event.data as { type?: string } | null)?.type === SW_SKIP_WAITING_MESSAGE) {
		void self.skipWaiting()
	}
})

self.addEventListener("activate", event => {
	event.waitUntil(self.clients.claim())
})

// Only synthetic endpoint this worker answers — no precache, no other fetch interception. Every
// other request falls through to the network untouched.
self.addEventListener("fetch", event => {
	const url = new URL(event.request.url)

	// Scope to a same-origin GET: a controlled client's cross-origin requests also route through this
	// worker, and only our own origin's GET should ever receive the synthetic version response.
	if (url.origin === self.location.origin && event.request.method === "GET" && url.pathname === "/__sw/version") {
		event.respondWith(new Response(JSON.stringify({ v: SW_PROTOCOL_VERSION }), { headers: { "Content-Type": "application/json" } }))
	}
})
