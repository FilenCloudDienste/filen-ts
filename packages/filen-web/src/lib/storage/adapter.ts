import { type, type Type } from "arktype"
import { acquireStorage, type StorageHandle } from "@/lib/storage/leader"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"

let handle: Promise<StorageHandle> | null = null

// Storage has exactly one backend now (OPFS-persistent) — a failed acquisition is a hard boot
// failure (see bootSdk's explicit storage probe), not a mode to report. Memoized per tab regardless
// of role: a leader opens its own worker once; a follower reuses the same election result for every
// kv call.
export function storage(): Promise<StorageHandle> {
	if (handle === null) {
		const attempt = acquireStorage()

		handle = attempt
		// A REJECTED attempt is un-memoized (guarded so a newer attempt is never clobbered): without
		// the reset, the first rejection — e.g. "no db leader after 10s" — would be replayed to every
		// storage() call for the rest of the tab's life. Callers of THIS attempt still see the
		// rejection (they await `attempt` itself, not this side chain).
		void attempt.catch(() => {
			if (handle === attempt) {
				handle = null
			}
		})
	}

	return handle
}

export async function kvGetJson<T>(key: string, schema: Type<T>): Promise<T | null> {
	const { api } = await storage()
	const raw = await api.kvGet(key)

	if (raw === null) {
		return null
	}

	let parsed: unknown

	try {
		parsed = parseEnvelope(raw)
	} catch {
		log.warn("kv", `dropping unparseable value at ${key}`)
		return null
	}

	const out = schema(parsed)

	if (out instanceof type.errors) {
		log.warn("kv", `dropping invalid value at ${key}`, out.summary)
		return null
	}

	// arktype's `Type<t>` callable returns `distill.Out<t>` (its "morph-aware" output shape), which
	// TS cannot statically prove equals the bare `T` this function is generic over — that distinction
	// only matters for schemas with `.pipe()`/default morphs, none of which this app's kv schemas use.
	// This narrow assertion (arktype's own documented generic-wrapper friction) is the bridge.
	return out as T
}

export async function kvSetJson(key: string, value: unknown): Promise<void> {
	const { api } = await storage()
	await api.kvSet(key, stringifyEnvelope(value))
}

// No envelope on delete — the key is the only argument. The primitive already exists in the worker
// layer; the adapter simply exposes it alongside get/set.
export async function kvDelete(key: string): Promise<void> {
	const { api } = await storage()
	await api.kvDelete(key)
}

// Raw existence check, independent of any schema: kvGetJson collapses "absent" and "present but
// schema-mismatched" to the same `null`, which is the right call for a normal typed read but makes
// it useless for proving a key is genuinely gone (e.g. after a wipe) when the caller does not also
// happen to hold the exact schema that key was written with.
export async function kvHas(key: string): Promise<boolean> {
	const { api } = await storage()
	return (await api.kvGet(key)) !== null
}

// Wipes every kv row — query-persist rows and keymap overrides included, the full local wipe
// logout needs. Composed from the two primitives already leader-routed (kvKeys/kvDelete) rather
// than adding a third worker op: an empty prefix matches every key (db.worker's `LIKE ? || '%'`),
// so nothing new needs registering in STORAGE_METHODS.
export async function kvClear(): Promise<void> {
	const { api } = await storage()
	const keys = await api.kvKeys("")
	// allSettled, not all: on a follower each delete is an independent RPC with its own timeout;
	// one slow delete must not abort the rest of the wipe.
	await Promise.allSettled(keys.map(key => api.kvDelete(key)))
}
