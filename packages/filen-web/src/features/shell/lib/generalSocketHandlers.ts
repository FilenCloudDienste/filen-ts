import type { SocketEvent, UserEventResult } from "@filen/sdk-rs"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { cachedQuery, invalidateJoiningInFlight } from "@/queries/patch"
import { EVENTS_QUERY_KEY, spliceNewEvent } from "@/features/settings/queries/events"
import { performLogout } from "@/features/shell/lib/performLogout"
import { log } from "@/lib/log"

// The realtime GENERAL event handlers — the account-scoped socket category (password changes + the
// server's "your account log has a new entry" ping), registered on the generic socket bridge alongside
// note/chat/drive/contact. A pure consumer; the bridge itself is untouched.

type GeneralSocketEvent = Extract<SocketEvent, { type: "general" }>

// Registers the general handler on the generic bridge; returns the unregister fn. Called once by the
// authed shell's socket host. Only "general" events reach handleGeneralEvent — the registry routes by type.
export function registerGeneralSocketHandlers(): () => void {
	return registerSocketHandler("general", handleGeneralEvent)
}

export function handleGeneralEvent(event: GeneralSocketEvent): void {
	const inner = event.inner

	switch (inner.type) {
		case "passwordChanged": {
			// The server rotated this session's credentials out from under us — force the SAME full local
			// wipe + reload the account menu's sign-out drives, so no decrypted state survives a password
			// change made from another device. `forced`: a dirty preview buffer can delay the wipe (the one
			// chance to copy that text out — nothing can be saved into a server-dead session) but never
			// cancel it, so this always completes. Fire-and-forget: performLogout isolates every phase and
			// never rejects, but its own reload can throw synchronously, so the promise is owned with a
			// catch here.
			void performLogout({ forced: true }).catch((e: unknown) => {
				log.error("socket", "passwordChanged force-logout failed", e)
			})

			break
		}

		case "newEvent": {
			// A mounted list reads the one event by its uuid (spliceNewEvent, which falls back to page one).
			// An events list nobody watches is only marked stale: its next mount reads page one once, however
			// many events arrived meanwhile. One nobody has opened has nothing to refresh.
			const query = cachedQuery<UserEventResult[]>(EVENTS_QUERY_KEY)

			if (query?.state.data === undefined) {
				break
			}

			if (query.isActive()) {
				void spliceNewEvent(inner.uuid)
			} else {
				invalidateJoiningInFlight(query)
			}

			break
		}

		default: {
			// Exhaustive over the wasm GeneralEvent union — a new variant fails to compile here until mapped.
			log.error("socket", "unhandled general event", (inner as { type: string }).type)

			break
		}
	}
}
