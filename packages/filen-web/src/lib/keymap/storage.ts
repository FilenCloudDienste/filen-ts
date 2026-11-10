import { type } from "arktype"
import { kvDelete, kvEntriesJson, kvGetJson, kvSetJson } from "@/lib/storage/adapter"
import { log } from "@/lib/log"

// Where the keymap lives: one OPFS kv record per account, so a second account on this browser starts from the
// defaults rather than from the first one's keys. A record written before any account is known (the sign-in screen's
// `?` dialog) is unclaimed: the next account to sign in without a record of its own adopts it. Per device and per
// origin; not synced across devices.
export const KEYMAP_ACCOUNT_PREFIX = "keymap.v2.account."
export const KEYMAP_UNCLAIMED_KEY = "keymap.v2.unclaimed"
// The previous format: overrides alone, wiped on every sign-out, so whatever it holds is the signed-in account's.
export const LEGACY_OVERRIDES_KEY = "keymap.v1.overrides"

export function keymapAccountKey(userId: string): string {
	return `${KEYMAP_ACCOUNT_PREFIX}${userId}`
}

// Every value a non-empty combo string; one bad value fails the whole record, which then falls back to the defaults,
// so corrupt data can never half-apply. "string > 0" is arktype's length bound on a string.
export const keymapOverridesSchema = type({ "[string]": "string > 0" })

export const keymapRecordSchema = type({ overrides: keymapOverridesSchema, characterKeys: "boolean" })

export interface KeymapRecord {
	// The user's combos by action id; UNBOUND_COMBO turns an action off.
	readonly overrides: Readonly<Record<string, string>>
	// The single-key (character key) shortcuts switch.
	readonly characterKeys: boolean
}

export const DEFAULT_RECORD: KeymapRecord = { overrides: {}, characterKeys: true }

export function readRecord(key: string): Promise<KeymapRecord | null> {
	return kvGetJson(key, keymapRecordSchema)
}

export async function readLegacyOverrides(): Promise<Record<string, string> | null> {
	return kvGetJson(LEGACY_OVERRIDES_KEY, keymapOverridesSchema)
}

export function writeRecord(key: string, record: KeymapRecord): Promise<void> {
	return kvSetJson(key, record)
}

export function deleteRecord(key: string): Promise<void> {
	return kvDelete(key)
}

// Sign-out wipes kv whole; the accounts' keymaps are put back after it, so a user keeps their keys on this device
// across sign-ins. Best effort: a read that fails keeps nothing, a write that fails loses only that record. Keyboard
// combos and the ids of the accounts that set them are all that survive.
export async function keepKeymapsAcrossWipe(wipe: () => Promise<void>): Promise<void> {
	let kept: [string, KeymapRecord][] = []

	try {
		kept = await kvEntriesJson(KEYMAP_ACCOUNT_PREFIX, keymapRecordSchema)
	} catch (error) {
		log.warn("keymap", "failed to read keymaps before the wipe", error)
	}

	await wipe()

	const restored = await Promise.allSettled(kept.map(([key, record]) => kvSetJson(key, record)))

	for (const outcome of restored) {
		if (outcome.status === "rejected") {
			log.warn("keymap", "failed to restore a keymap after the wipe", outcome.reason)
		}
	}
}

// Live updates between this origin's tabs: a write posts the whole record (a few hundred bytes), so a receiver applies
// it without a kv read. A channel never hears its own posts.
const CHANNEL_NAME = "filen-keymap"

interface KeymapMessage {
	key: string
	record: KeymapRecord
}

const messageSchema = type({ key: "string", record: keymapRecordSchema })

let channel: BroadcastChannel | null | undefined

function keymapChannel(): BroadcastChannel | null {
	if (channel === undefined) {
		channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL_NAME)
		// Node's channel would otherwise hold a test process open.
		;(channel as { unref?: () => void } | null)?.unref?.()
	}

	return channel
}

export function postRecord(key: string, record: KeymapRecord): void {
	try {
		keymapChannel()?.postMessage({ key, record } satisfies KeymapMessage)
	} catch (error) {
		log.warn("keymap", "failed to post a keymap change", error)
	}
}

export function onRecordPosted(handler: (key: string, record: KeymapRecord) => void): () => void {
	const target = keymapChannel()

	if (target === null) {
		return () => undefined
	}

	const listener = (event: MessageEvent<unknown>): void => {
		const message = messageSchema(event.data)

		if (!(message instanceof type.errors)) {
			handler(message.key, message.record)
		}
	}

	target.addEventListener("message", listener)

	return () => {
		target.removeEventListener("message", listener)
	}
}
