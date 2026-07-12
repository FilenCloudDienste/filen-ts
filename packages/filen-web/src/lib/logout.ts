import { asErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

// Injected collaborators so the phased wipe is unit-testable without a worker, kv backend, or DOM —
// mirrors loginAttempt.ts/resetAttempt.ts's shape (and, like that module, stays free of any
// worker-constructing import: @/lib/sdk/client builds its worker eagerly at module load, which
// would crash this file's own node-environment test the moment it was merely imported). The real
// collaborators are wired at the call site — see iconRail.tsx's AccountMenu. Sync ops
// (clearQueryCache/broadcast/reload) stay `void`-returning, matching their real counterparts
// (QueryClient#clear, broadcastAuth, location.reload).
export interface LogoutDeps {
	cancelQueries: () => Promise<void>
	clearQueryCache: () => void
	sdkLogout: () => Promise<void>
	clearSession: () => Promise<void>
	kvClear: () => Promise<void>
	wipeServiceWorker: () => Promise<void>
	broadcast: () => void
	reload: () => void
}

// Runs one phase in isolation. Accepts a sync OR async collaborator: `Promise.resolve().then(fn)` —
// not a bare `fn()` — because a SYNCHRONOUS throw (e.g. a closed BroadcastChannel's postMessage)
// must turn into a rejection here too, or Promise.allSettled below would never see it and the throw
// would escape this function, aborting every later phase — exactly what this helper exists to
// prevent. A rejection is logged and swallowed either way.
async function phase(label: string, fn: () => void | Promise<void>): Promise<void> {
	const [outcome] = await Promise.allSettled([Promise.resolve().then(fn)])
	if (outcome.status === "rejected") {
		log.error("logout", `${label} failed`, asErrorDTO(outcome.reason))
	}
}

// The phased local wipe. Order is load-bearing — wipe fully lands, THEN broadcast, THEN reload:
// broadcasting earlier loses two races — a fast follower tab reloads and reads the still-valid
// session back in, and if this tab is itself a storage follower, the leader tab would reload itself
// dead before the wipe RPC ever reaches it (no re-election exists), silently resurrecting the
// session. Every phase is isolated (log-and-continue): a failure anywhere still falls through to the
// next phase rather than stalling the sign-out partway, so a torn wipe still reaches a fresh reload.
export async function runLogout(deps: LogoutDeps): Promise<void> {
	// Stop consumers first — a query settling after the wipe starts must not repopulate the cache.
	// Two independent phases, not one: clearing the in-memory cache does not depend on the cancel
	// having succeeded, so a cancelQueries failure must not skip it.
	await phase("cancel-queries", deps.cancelQueries)
	await phase("clear-query-cache", deps.clearQueryCache)
	// Worker nulls the client immediately (new ops fail fast); the handle free is deferred.
	await phase("sdk-logout", deps.sdkLogout)
	// Session row first, then every remaining kv row — query-persist rows and keymap overrides
	// included: logout is a full local wipe by design, matching the confirm dialog's copy.
	await phase("clear-session", deps.clearSession)
	await phase("kv-clear", deps.kvClear)
	// The service worker keeps its own reconstructed Client (decrypted key material) that no store wipe
	// above reaches — signal it to drop that + any pending downloads before the reload, so no secret
	// survives sign-out inside the worker.
	await phase("wipe-service-worker", deps.wipeServiceWorker)
	// Other tabs reload only once the wipe has landed, per the race above.
	await phase("broadcast", deps.broadcast)
	// Fresh boot lands on /login. No retry loop — a reload failure leaves a torn-but-unauthed state
	// and the next manual reload completes it.
	await phase("reload", deps.reload)
}
