import { type } from "arktype"
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import { persistQueryClient, type AsyncStorage, type PersistedClient } from "@tanstack/react-query-persist-client"
import type { QueryClient } from "@tanstack/react-query"
import { storage } from "@/lib/storage/adapter"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"

// Versioned kv key AND cache-buster in one (brief T6): bumping this both moves the persisted
// cache to a fresh kv row and makes `persistQueryClientRestore` treat any older-versioned blob as
// busted — the two concerns are deliberately the same constant, never two that could drift apart.
export const PERSIST_KEY = "rq.v1.cache"

// D11: every kv read is arktype-validated. This only checks the OUTER `PersistedClient` envelope —
// `clientState`'s internals (`queries`/`mutations`) are TanStack-owned and already defended by
// `hydrate()`'s own `dehydratedState.mutations || []` / `.queries || []` fallback (verified in the
// installed @tanstack/query-core source, src/hydration.ts) — re-validating that nested shape here
// would duplicate that guarantee for no safety gain, mirroring D11's "SDK returns are NOT
// re-validated" precedent for TanStack's own internal query state.
const persistedClientSchema = type({
	buster: "string",
	timestamp: "number",
	clientState: "object"
})

// The sanctioned "restore to empty" shape (verified against the installed
// query-persist-client-core/src/persist.ts): `persistQueryClientRestore` skips `hydrate()`
// entirely whenever `persistedClient.timestamp` is falsy, going straight to `removeClient()` —
// the branch it reserves for a malformed/legacy persisted client, distinct from the
// expired-or-busted branch used for a well-formed-but-stale cache. Returning this from
// `deserialize` below both self-heals the corrupted kv row and guarantees the cache restores
// empty, without ever throwing. `buster: ""` is a second, independent guard: it can never equal
// the real (non-empty) `PERSIST_KEY` buster, so even if the timestamp check ever changed
// upstream, the buster mismatch alone would still force the same `removeClient()` path.
// The alternative — letting `deserialize` throw — also reaches `removeClient()`, but
// `persistQueryClientRestore` then RE-THROWS, rejecting `persistQueryClient`'s restore promise;
// this shape avoids handing T9 (the `__root` wiring) an unhandled rejection to remember to catch.
const EMPTY_CLIENT: PersistedClient = { buster: "", timestamp: 0, clientState: { queries: [], mutations: [] } }

function deserialize(cached: string): PersistedClient {
	let parsed: unknown

	try {
		parsed = parseEnvelope(cached)
	} catch (e) {
		log.warn("query.persist", "dropping unparseable persisted cache envelope", e)
		return EMPTY_CLIENT
	}

	const out = persistedClientSchema(parsed)

	if (out instanceof type.errors) {
		log.warn("query.persist", "dropping invalid persisted cache envelope", out.summary)
		return EMPTY_CLIENT
	}

	// arktype's callable `Type` returns `distill.Out<t>`; this schema only asserts the outer shape
	// (`clientState: "object"`, see the comment above), so its inferred output doesn't structurally
	// satisfy `PersistedClient`'s `clientState: DehydratedState`. This narrow assertion bridges that
	// gap — the same friction, resolved the same way, as `kvGetJson`'s in src/lib/storage/adapter.ts.
	return out as PersistedClient
}

// The persister wants an AsyncStorage-shaped `{getItem,setItem,removeItem}` over STRINGS — bridge
// straight to the kv worker's own string API. NOT `kvGetJson`/`kvSetJson`: those already run
// values through the envelope serializer, and `serialize`/`deserialize` below do that exact job
// for the persister's payload — going through both would double-envelope every write.
const kvAsyncStorage: AsyncStorage = {
	getItem: async key => {
		const { api } = await storage()
		return api.kvGet(key)
	},
	setItem: async (key, value) => {
		const { api } = await storage()
		await api.kvSet(key, value)
	},
	removeItem: async key => {
		const { api } = await storage()
		await api.kvDelete(key)
	}
}

// libs.md's actual recommendation: whole-client persistence via `persistQueryClient` +
// `createAsyncStoragePersister` — NOT `experimental_createQueryPersister` (rev 1's mistake; that
// per-query API is explicitly flagged experimental in the installed source and solves a different
// problem, fine-grained per-query persistence, not "restore the whole client on boot").
export const persister = createAsyncStoragePersister({
	storage: kvAsyncStorage,
	key: PERSIST_KEY,
	serialize: stringifyEnvelope,
	deserialize
})

// Restores the persisted cache onto `client` and subscribes it to future cache changes; T9 calls
// this once from `__root` with the app's `queryClient` singleton (taken as a parameter, rather
// than importing the singleton directly, so this stays independently testable with a throwaway
// QueryClient). Returns `persistQueryClient`'s own tuple verbatim — `unsubscribe` for teardown
// (e.g. HMR) and `restored`, which settles once the restore attempt (success, empty, or dropped)
// has finished; T9 may await it before first paint.
export function setupQueryPersistence(client: QueryClient): [unsubscribe: () => void, restored: Promise<void>] {
	return persistQueryClient({ queryClient: client, persister, buster: PERSIST_KEY })
}
