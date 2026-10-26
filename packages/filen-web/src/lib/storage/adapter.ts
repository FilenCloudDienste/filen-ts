import type { Type } from "arktype"
import { acquireStorage, type StorageHandle } from "@/lib/storage/leader"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"
import { decodeValue } from "@/lib/storage/decode"
import { nextTask } from "@/lib/nextTask"

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

// How long kvEntriesJsonInSlices decodes before it lets the thread go, and how many rows cross from the storage
// worker per message.
const DECODE_SLICE_MS = 4
const ENTRIES_PAGE_ROWS = 2000

// kvEntriesJson for a prefix that may hold tens of thousands of rows: read a page at a time and decoded a few
// milliseconds at a time, so the thread it runs on keeps answering in between. With `map`, each row is reduced as
// it is decoded and only what that returns is kept. A leader on an older build without paging answers in one read.
export function kvEntriesJsonInSlices<T>(prefix: string, schema: Type<T>): Promise<[string, T][]>
export function kvEntriesJsonInSlices<T, R>(prefix: string, schema: Type<T>, map: (key: string, value: T) => R): Promise<R[]>
export async function kvEntriesJsonInSlices<T, R>(
	prefix: string,
	schema: Type<T>,
	map?: (key: string, value: T) => R
): Promise<(R | [string, T])[]> {
	const { api } = await storage()
	const out: (R | [string, T])[] = []
	let after: string | null = null
	let sliceStart = performance.now()

	for (;;) {
		let rows: [string, string][]
		let last = false

		try {
			rows = await api.kvEntriesPage(prefix, after, ENTRIES_PAGE_ROWS)
		} catch (e) {
			if (after !== null || !isMissingStorageMethod(e)) {
				throw e
			}

			rows = await api.kvEntries(prefix)
			last = true
		}

		for (const [key, raw] of rows) {
			const value = decodeKvValue(key, raw, schema)

			if (value !== null) {
				out.push(map === undefined ? [key, value] : map(key, value))
			}

			if (performance.now() - sliceStart >= DECODE_SLICE_MS) {
				await nextTask()

				sliceStart = performance.now()
			}
		}

		if (last || rows.length < ENTRIES_PAGE_ROWS) {
			return out
		}

		after = rows.at(-1)?.[0] ?? null
	}
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

// The stored string as is, for a reader that decodes it itself.
export async function kvGet(key: string): Promise<string | null> {
	const { api } = await storage()
	return api.kvGet(key)
}

// Raw existence check, independent of any schema: kvGetJson collapses "absent" and "present but
// schema-mismatched" to the same `null`, which is the right call for a normal typed read but makes
// it useless for proving a key is genuinely gone (e.g. after a wipe) when the caller does not also
// happen to hold the exact schema that key was written with.
export async function kvHas(key: string): Promise<boolean> {
	const { api } = await storage()
	return (await api.kvGet(key)) !== null
}

// The keys under a prefix without their values.
export async function kvKeys(prefix: string): Promise<string[]> {
	const { api } = await storage()
	return api.kvKeys(prefix)
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

// Every row under a prefix: one statement, or one delete per key from a leader on an older build.
export async function kvDeletePrefix(prefix: string): Promise<void> {
	const { api } = await storage()

	try {
		await api.kvDeletePrefix(prefix)
	} catch (e) {
		if (!isMissingStorageMethod(e)) {
			throw e
		}

		const keys = await api.kvKeys(prefix)

		await Promise.all(keys.map(key => api.kvDelete(key)))
	}
}

// Deletes each key whose row still holds that `at` (a row rewritten since stays): one transaction, or a read and a
// delete per key from a leader on an older build. Resolves the keys deleted.
export async function kvDeleteIfAt(entries: readonly (readonly [string, number])[]): Promise<string[]> {
	const { api } = await storage()

	try {
		return await api.kvDeleteIfAt(entries.map(([key, at]): [string, number] => [key, at]))
	} catch (e) {
		if (!isMissingStorageMethod(e)) {
			throw e
		}
	}

	const deleted: string[] = []

	for (const [key, at] of entries) {
		const raw = await api.kvGet(key)
		let value: unknown

		try {
			value = raw === null ? null : parseEnvelope(raw)
		} catch {
			continue
		}

		if (typeof value === "object" && value !== null && "at" in value && value.at === at) {
			await api.kvDelete(key)
			deleted.push(key)
		}
	}

	return deleted
}

// The database reset (db.worker.ts wipe), or false from a leader on an older build without it.
async function resetDatabase(api: StorageHandle["api"]): Promise<boolean> {
	try {
		await api.wipe()

		return true
	} catch (e) {
		if (!isMissingStorageMethod(e)) {
			throw e
		}

		return false
	}
}

// Wipes every kv row — query-persist rows and keymap overrides included, the full local wipe
// logout needs. The first pass resets the database files, which leaves none of the deleted plaintext
// on disk; the second is one prefix delete (an empty prefix covers every key): a single statement and a
// single follower RPC, rather than an enumeration plus one autocommit delete per row.
export async function kvClear(): Promise<void> {
	const { api } = await storage()
	let prefixDelete = true
	let failure: { reason: unknown } | null = null

	// Sweep TWICE. A write already in flight when the wipe starts — e.g. an outbox flush past its own
	// abort gate, or any other persist racing logout — can land after the first pass and would survive
	// the "full wipe" as a decrypted row that replays on the next boot. A second sweep after the first
	// drained catches that straggler. Bounded at two passes: the outbox channel is closed before logout
	// reaches here, so no NEW write can originate; only an already-in-flight one remains, and it completes
	// within the first pass. A failed pass (e.g. a follower RPC timeout) still runs the other one.
	for (let pass = 0; pass < 2; pass++) {
		try {
			if (pass === 0 && (await resetDatabase(api))) {
				continue
			}

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
