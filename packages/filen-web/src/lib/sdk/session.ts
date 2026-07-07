import { type } from "arktype"
import type { StringifiedClient } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { kvGetJson, kvSetJson, kvDelete } from "@/lib/storage/adapter"
import { asErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"

// The single kv key the persisted SDK session blob lives under, so save/restore and the e2e seed
// agree on one key. The blob is written via `kvSetJson` (envelope-serialized, bigint-safe — the
// StringifiedClient carries a bigint `userId`).
export const SESSION_KV_KEY = "sdk.session.v1"

// Versioned channel carrying auth *events* only (never key material) so open tabs stay coherent.
const AUTH_CHANNEL = "filen.auth.v1"

type AuthMessage = { kind: "login" } | { kind: "logout" }

// Schema for the persisted blob — mirrors `@filen/sdk-rs`'s `StringifiedClient` so the restore path
// validates on read like every other kv consumer, without re-deriving the shape.
export const sessionSchema = type({
	email: "string",
	userId: "bigint",
	rootUuid: "string",
	authInfo: "string",
	privateKey: "string",
	apiKey: "string",
	authVersion: "number",
	"maxParallelRequests?": "number",
	"maxIoMemoryUsage?": "number"
})

// The session blob is stored PLAIN at rest, by decision: a best-effort WebCrypto wrap buys no real
// protection (the unwrap key would have to live beside it), so XSS defense is the CSP, not a storage
// trick. The blob is secret-equivalent regardless — never log it, never put it in an error/trace.
export async function persistSession(blob: StringifiedClient): Promise<void> {
	await kvSetJson(SESSION_KV_KEY, blob)
}

export async function clearSession(): Promise<void> {
	await kvDelete(SESSION_KV_KEY)
}

// Read the persisted blob, validate it, and inject it into the worker. Returns false when there is
// no session, an unreadable one (kvGetJson already dropped it), or one the SDK rejects. An
// ephemeral (`:memory:`) kv never has a prior-reload blob to read — resume is a no-op there, matching
// the ephemeral indicator.
export async function resumeSession(): Promise<boolean> {
	const blob = await kvGetJson(SESSION_KV_KEY, sessionSchema)
	if (blob === null) {
		return false
	}
	try {
		await sdkApi.injectClient(blob)
		return true
	} catch (e) {
		// Schema-valid but the SDK rejected it (stale/tampered internal fields): drop it so the next
		// boot starts clean instead of re-failing on the same blob forever. Never boot-loop.
		log.warn("session", "persisted session rejected; clearing", asErrorDTO(e).label)
		await clearSession()
		return false
	}
}

// One shared channel per tab: a BroadcastChannel never receives its OWN posts, so the tab that
// triggered the event does not react to it (only other tabs do) — no self-reload loop.
let authChannel: BroadcastChannel | null = null

function authBroadcastChannel(): BroadcastChannel {
	authChannel ??= new BroadcastChannel(AUTH_CHANNEL)
	return authChannel
}

export function broadcastAuth(kind: AuthMessage["kind"]): void {
	authBroadcastChannel().postMessage({ kind } satisfies AuthMessage)
}

export function onAuthBroadcast(handler: (message: AuthMessage) => void): () => void {
	const channel = authBroadcastChannel()
	const listener = (event: MessageEvent<AuthMessage>): void => {
		handler(event.data)
	}
	channel.addEventListener("message", listener)
	return () => {
		channel.removeEventListener("message", listener)
	}
}
