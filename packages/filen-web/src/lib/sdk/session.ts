import type { StringifiedClient } from "@filen/sdk-rs"
import { type } from "arktype"
import { parseEnvelope, sessionSchema, stringifyEnvelope } from "@filen/shared/session"
import { sdkApi } from "@/lib/sdk/client"
import { kvGet, kvSetJson, kvDelete, kvHas } from "@/lib/storage/adapter"
import { desktopBridge } from "@/lib/desktop"
import { asErrorDTO } from "@/lib/sdk/errors"
import { log } from "@/lib/log"
import { writeSignedInHint } from "@/lib/signedInHint"

// The single kv key the persisted SDK session blob lives under in the browser. The blob is written via
// `kvSetJson` (envelope-serialized, bigint-safe — the StringifiedClient carries a bigint `userId`).
const SESSION_KV_KEY = "sdk.session.v1"

// Versioned channel carrying auth *events* only (never key material) so open tabs stay coherent.
const AUTH_CHANNEL = "filen.auth.v1"

type AuthMessage = { kind: "login" } | { kind: "logout" }

// On desktop the session lives only in the shell's keychain-backed vault, never in web storage; the same envelope
// string crosses the bridge. The browser stores it PLAIN in kv, by decision: a best-effort WebCrypto wrap buys no
// real protection (the unwrap key would have to live beside it), so XSS defense is the CSP, not a storage trick.
// The blob is secret-equivalent regardless — never log it, never put it in an error/trace. Every session write and
// delete goes through these two, so the splash's signed-in hint follows them here.
export async function persistSession(blob: StringifiedClient): Promise<void> {
	const vault = desktopBridge()?.session

	await (vault === undefined ? kvSetJson(SESSION_KV_KEY, blob) : vault.set(stringifyEnvelope(blob)))
	writeSignedInHint(true)
}

export async function clearSession(): Promise<void> {
	writeSignedInHint(false)

	const vault = desktopBridge()?.session

	await (vault === undefined ? kvDelete(SESSION_KV_KEY) : vault.clear())
}

// A sign-out's kv wipe already removes the browser's session; the desktop vault needs its own clear.
export function clearSessionOutsideKv(): Promise<void> {
	return desktopBridge()?.session.clear() ?? Promise.resolve()
}

export async function hasPersistedSession(): Promise<boolean> {
	const vault = desktopBridge()?.session

	return vault === undefined ? kvHas(SESSION_KV_KEY) : (await vault.get()) !== null
}

// An unparseable or invalid blob reads as no session (and is logged), like every other kv value.
function decodeSession(raw: string): StringifiedClient | null {
	let parsed: unknown

	try {
		parsed = parseEnvelope(raw)
	} catch {
		log.warn("session", "dropping unparseable persisted session")

		return null
	}

	const result = sessionSchema(parsed)

	if (result instanceof type.errors) {
		// Paths only, never values: the path list is all a report needs.
		log.warn("session", "dropping invalid persisted session", result.map(error => error.path.join(".")).join(", "))

		return null
	}

	return result
}

// Read the persisted blob, validate it, and inject it into the worker. Returns false when there is
// no session, an unreadable one (decodeSession dropped it), or one the SDK rejects. Reconciles the
// signed-in hint either way, so a stale one corrects itself on the next boot. Rejects when the desktop vault
// holds a session it cannot read right now (locked keychain): boot shows its error screen and nothing is cleared.
export async function resumeSession(): Promise<boolean> {
	const vault = desktopBridge()?.session
	const raw = await (vault === undefined ? kvGet(SESSION_KV_KEY) : vault.get())
	const blob = raw === null ? null : decodeSession(raw)

	if (blob === null) {
		writeSignedInHint(false)
		return false
	}
	try {
		await sdkApi.injectClient(blob)
		writeSignedInHint(true)
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
