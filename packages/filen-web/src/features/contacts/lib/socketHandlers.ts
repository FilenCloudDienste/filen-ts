import type { SocketEvent } from "@filen/sdk-rs"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { contactRequestsQueryUpdate } from "@/features/contacts/queries/contacts"

// The realtime CONTACT event handlers — a faithful port of filen-mobile's contacts socketHandlers.ts
// semantics onto the wasm surface, registered on the generic socket bridge. The wasm ContactEvent union
// carries exactly ONE variant today (contactRequestReceived), so `inner` is read directly rather than
// switched: a discriminant check on a single-member union is a statically-known comparison the linter
// rejects. When the SDK grows the union, `inner` widens and the field reads below stop compiling — that
// compile break is the signal to reintroduce a switch and map the new variants.

type ContactSocketEvent = Extract<SocketEvent, { type: "contact" }>

// Registers the contact handler on the generic bridge; returns the unregister fn. Called once by the
// authed shell's socket host. Only "contact" events reach handleContactEvent — the registry routes by type.
export function registerContactSocketHandlers(): () => void {
	return registerSocketHandler("contact", handleContactEvent)
}

export function handleContactEvent(event: ContactSocketEvent): void {
	const inner = event.inner

	// Splice the new incoming request into the requests cache, replacing any prior entry with the same
	// uuid (a re-delivered event never duplicates). senderId is `number` on the wasm surface — every
	// other user id is bigint (ContactRequestIn.userId) — so it must be coerced before it lands.
	contactRequestsQueryUpdate(prev => ({
		...prev,
		incoming: [
			...prev.incoming.filter(r => r.uuid !== inner.uuid),
			{
				uuid: inner.uuid,
				userId: BigInt(inner.senderId),
				email: inner.senderEmail,
				// exactOptionalPropertyTypes: `avatar?: string` must be ABSENT (not `undefined`) when the
				// sender has none, so it's spread in only when present rather than set to undefined.
				...(inner.senderAvatar !== undefined ? { avatar: inner.senderAvatar } : {}),
				nickName: inner.senderNickName
			}
		]
	}))
}
