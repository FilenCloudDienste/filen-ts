import type { Chat, ChatParticipant, Contact } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { chatsQueryUpsert } from "@/features/chats/queries/chats"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type ActionOutcome } from "@/lib/actions/outcome"
import { type BulkFailure, type BulkOutcome } from "@/features/drive/lib/bulk"

export type { ActionOutcome }

// Chat-participant actions — the chatParticipantsDialog counterpart to notes/lib/participants.ts, same
// confirm-then-patch shape and same owner-only gating (chatMenu.logic.ts hides these entries for a
// non-owner; the dialog itself hides the add/remove controls too — this layer is the third, defense-
// in-depth gate for addChatParticipant/removeChatParticipant call sites that VERIFIED against mobile's
// own createMenuButtons/chatParticipants.tsx: both are owner-only, unlike notes' write-permission model
// (chats have no per-participant permission concept — remove-only management).

// Idempotent, sequential add (mobile's addParticipants, chats.ts:408-443): every already-present
// contact is skipped up front; the remaining adds thread the PREVIOUS call's result chat into the
// next, so the one cache write at the end keeps every new participant. A parallel Promise.all would
// each compute "base chat + its own contact" off the same stale chat and the last write to resolve
// would clobber the rest — mobile's own documented bug this ports around.
export async function addChatParticipants(chat: Chat, contacts: readonly Contact[]): Promise<ActionOutcome<Chat>> {
	const toAdd = contacts.filter(contact => !chat.participants.some(p => p.userId === contact.userId))

	if (toAdd.length === 0) {
		return { status: "success", item: chat }
	}

	let updated = chat

	try {
		for (const contact of toAdd) {
			updated = await runOp(sdkApi.addChatParticipant(updated, contact))
		}
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	chatsQueryUpsert(updated)

	return { status: "success", item: updated }
}

// Owner removing someone else — self-removal stays the separate leaveChat flow in lib/actions.ts,
// never routed through here (mirrors notes' removeNoteParticipant vs. leaveNote split).
export async function removeChatParticipant(chat: Chat, participant: ChatParticipant): Promise<ActionOutcome<Chat>> {
	if (!chat.participants.some(p => p.userId === participant.userId)) {
		return { status: "success", item: chat }
	}

	let updated: Chat

	try {
		updated = await runOp(sdkApi.removeChatParticipant(chat, participant.userId))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	chatsQueryUpsert(updated)

	return { status: "success", item: updated }
}

// Bulk counterpart of removeChatParticipant, for the owner-only multi-select in chatParticipantsDialog.
// Deliberately SEQUENTIAL, unlike drive's generic runBulk (parallel, independent items): every removal
// mutates the SAME chat's participants list, so a parallel Promise.all would have each call compute
// "current chat minus its own participant" off the same stale snapshot and the last write to resolve
// would silently restore whichever participants an earlier call already removed — the exact hazard
// addChatParticipants' own doc comment above describes for adds. One rejected removal does not abort
// the rest (partial-success, like every other bulk surface in this app) — it just carries the chat
// state from the last successful step forward into the next attempt.
export async function removeChatParticipants(
	chat: Chat,
	participants: readonly ChatParticipant[]
): Promise<{ chat: Chat; outcome: BulkOutcome<ChatParticipant> }> {
	let current = chat
	const succeeded: ChatParticipant[] = []
	const failed: BulkFailure<ChatParticipant>[] = []

	for (const participant of participants) {
		const outcome = await removeChatParticipant(current, participant)

		if (outcome.status === "error") {
			failed.push({ item: participant, error: outcome.dto })
			continue
		}

		current = outcome.item
		succeeded.push(participant)
	}

	return { chat: current, outcome: { succeeded, failed } }
}
