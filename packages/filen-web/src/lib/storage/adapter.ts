import { type, type Type } from "arktype"
import { acquireStorage, type StorageHandle } from "@/lib/storage/leader"
import { parseEnvelope, stringifyEnvelope } from "@/lib/serialize"
import { log } from "@/lib/log"
import { useBootStore } from "@/stores/boot"

let handle: Promise<StorageHandle> | null = null

// Reflects the resolved backend into the boot store exactly once per tab (T5 Step 4) — asks the
// API for its mode rather than assuming, so a follower tab (whose own `open()` never ran) still
// reports the leader's real mode. Badge UI consuming `useBootStore().ephemeral` lands in T9.
async function markEphemeralIndicator(): Promise<void> {
	useBootStore.getState().setEphemeral((await storageMode()) === "ephemeral")
}

export function storage(): Promise<StorageHandle> {
	if (handle === null) {
		handle = acquireStorage(new URLSearchParams(location.search).has("ephemeral"))
		// Side-channel only — failures here must never surface anywhere but the `handle` promise
		// itself (which every real caller awaits directly), so both branches are swallowed.
		void handle.then(markEphemeralIndicator, () => undefined).catch(() => undefined)
	}

	return handle
}

export async function storageMode(): Promise<"persistent" | "ephemeral"> {
	const { api } = await storage()
	return api.mode() // followers ask the leader — never assume (rev-1 hardcoded this wrong)
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
