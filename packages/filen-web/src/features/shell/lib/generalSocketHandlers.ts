import type { SocketEvent } from "@filen/sdk-rs"
import { registerSocketHandler } from "@/lib/sdk/socket"
import { queryClient } from "@/queries/client"
import { EVENTS_QUERY_KEY } from "@/features/settings/queries/events"
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
			// change made from another device. Fire-and-forget: performLogout isolates every phase and never
			// rejects, but its own reload can throw synchronously, so the promise is owned with a catch here.
			void performLogout().catch((e: unknown) => {
				log.error("socket", "passwordChanged force-logout failed", e)
			})

			break
		}

		case "newEvent": {
			// The payload carries only a raw eventType string + opaque info — not the typed id/kind the
			// account-events list renders and dedupes on — so it can act only as a "something changed"
			// trigger, never a splice: refetch page one. Guarded on an existing cache slice — an events list
			// nobody has opened yet has nothing to refresh, and refetching would fetch into a slice no view
			// reads (its own mount refetches from scratch anyway, staleTime 0).
			if (queryClient.getQueryData(EVENTS_QUERY_KEY) !== undefined) {
				void queryClient.invalidateQueries({ queryKey: EVENTS_QUERY_KEY })
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
