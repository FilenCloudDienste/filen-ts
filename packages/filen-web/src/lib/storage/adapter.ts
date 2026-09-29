import type { Type } from "arktype"
import { acquireStorage, type StorageHandle } from "@/lib/storage/leader"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"
import { decodeValue } from "@/lib/storage/decode"

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

function decodeKvValue<T>(key: string, raw: string, schema: Type<T>): T | null {
	let parsed: unknown

	try {
		parsed = parseEnvelope(raw)
	} catch {
		log.warn("kv", `dropping unparseable value at ${key}`)

		return null
	}

	return decodeValue(parsed, schema, "kv", `value at ${key}`)
}

export async function kvGetJson<T>(key: string, schema: Type<T>): Promise<T | null> {
	const { api } = await storage()
	const raw = await api.kvGet(key)

	return raw === null ? null : decodeKvValue(key, raw, schema)
}

// Every row under a prefix in one round trip, each validated like kvGetJson; a row that fails to parse
// or validate is dropped (and logged), never allowed to fail the whole read.
export async function kvEntriesJson<T>(prefix: string, schema: Type<T>): Promise<[string, T][]> {
	const { api } = await storage()
	const rows = await api.kvEntries(prefix)
	const out: [string, T][] = []

	for (const [key, raw] of rows) {
		const value = decodeKvValue(key, raw, schema)

		if (value !== null) {
			out.push([key, value])
		}
	}

	return out
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

// A leader tab still on an older build has no kvDeletePrefix: its db worker rejects the unknown Comlink
// method with a TypeError, and leader forwarding keeps the error's name. Tabs run different builds only
// while an update waits for the user to confirm it.
function isMissingStorageMethod(e: unknown): boolean {
	return e instanceof Error && e.name === "TypeError"
}

// The per-key wipe every build's leader serves. Every delete runs even when one fails, since on a
// follower each is an independent RPC with its own timeout.
async function kvDeleteEach(api: StorageHandle["api"]): Promise<void> {
	const keys = await api.kvKeys("")
	const failed = (await Promise.allSettled(keys.map(key => api.kvDelete(key)))).find(result => result.status === "rejected")

	if (failed !== undefined) {
		throw failed.reason
	}
}

// Wipes every kv row — query-persist rows and keymap overrides included, the full local wipe
// logout needs. One prefix delete per pass (an empty prefix covers every key): a single statement
// and a single follower RPC, rather than an enumeration plus one autocommit delete per row.
export async function kvClear(): Promise<void> {
	const { api } = await storage()
	let prefixDelete = true
	let failure: { reason: unknown } | null = null

	// Sweep TWICE. A write already in flight when the wipe starts — e.g. an outbox flush past its own
	// abort gate, or any other persist racing logout — can land after the first delete and would survive
	// the "full wipe" as a decrypted row that replays on the next boot. A second sweep after the first
	// drained catches that straggler. Bounded at two passes: the outbox channel is closed before logout
	// reaches here, so no NEW write can originate; only an already-in-flight one remains, and it completes
	// within the first pass. A failed pass (e.g. a follower RPC timeout) still runs the other one.
	for (let pass = 0; pass < 2; pass++) {
		try {
			if (prefixDelete) {
				try {
					await api.kvDeletePrefix("")
				} catch (e) {
					if (!isMissingStorageMethod(e)) {
						throw e
					}

					prefixDelete = false
				}
			}

			if (!prefixDelete) {
				await kvDeleteEach(api)
			}
		} catch (e) {
			failure = { reason: e }
		}
	}

	if (failure !== null) {
		throw failure.reason
	}
}
