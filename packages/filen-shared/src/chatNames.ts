import { type ContactLike, contactDisplayName } from "./contacts"
import { fastLocaleCompare } from "./misc"

// Participant-name tail of a chat's display title, shared verbatim by every caller: no other
// participants (everyone else left) falls back to the caller's placeholder; exactly one other
// participant is shown directly; several are joined, locale-sorted for a stable order. The
// explicit chat.name-wins check and any undecryptable handling are surface-specific (they read
// generated SDK fields that differ per app) and stay in each caller's own wrapper.
export function resolveChatParticipantsDisplayName(others: readonly ContactLike[], soloFallback: string): string {
	if (others.length === 0) {
		return soloFallback
	}

	if (others.length === 1) {
		const other = others[0]

		if (other) {
			return contactDisplayName(other)
		}
	}

	return others.map(contactDisplayName).sort(fastLocaleCompare).join(", ")
}
