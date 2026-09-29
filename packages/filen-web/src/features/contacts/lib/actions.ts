import type { BlockedContact, Chat, Contact, UuidStr } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import {
	contactRequestsQueryUpdate,
	contactsQueryUpdate,
	rereadContactList,
	rereadOutgoingRequests
} from "@/features/contacts/queries/contacts"
import { asErrorDTO } from "@/lib/sdk/errors"
import { attemptOp, runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { createChat } from "@/features/chats/lib/actions"

export type { VoidActionOutcome }

// One typed async helper per contact action — zero-`useMutation`: each calls its worker op, then
// (only on success) patches the affected query cache directly. Every helper returns a
// VoidActionOutcome and never throws; LABEL-FIRST error shaping comes from runOp/asErrorDTO, mirrored
// from features/drive/lib/actions.ts. Cache-patch semantics mirror the mobile contacts feature exactly.

export async function sendContactRequest(email: string): Promise<VoidActionOutcome> {
	try {
		// The op's own return (the new request's uuid) is discarded — a fresh listOutgoingContactRequests
		// is the source of truth for the patch, same as the mobile client.
		await runOp(sdkApi.sendContactRequest(email))
		await rereadOutgoingRequests()
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	return { status: "success" }
}

export async function acceptRequest(uuid: string): Promise<VoidActionOutcome> {
	const outcome = await attemptOp(sdkApi.acceptContactRequest(uuid))

	if (outcome.status === "error") {
		return outcome
	}

	// Immediate feedback: drop the request from incoming without waiting on a refetch.
	contactRequestsQueryUpdate(prev => ({ ...prev, incoming: prev.incoming.filter(r => r.uuid !== uuid) }))

	// The accepted request promotes to a full contact server-side, but the op's return is only a bare
	// uuid — not enough to reconstruct a Contact (nickname/avatar/publicKey/... are unknown here), so the
	// contact list is read back. The removal above already leaves the requests cache right, and blocked
	// contacts are untouched. Not awaited: the removal above is the immediate feedback, and a failed
	// read-back marks the contacts stale itself.
	rereadContactList().catch(() => undefined)

	return { status: "success" }
}

export async function denyRequest(uuid: string): Promise<VoidActionOutcome> {
	const outcome = await attemptOp(sdkApi.denyContactRequest(uuid))

	if (outcome.status === "error") {
		return outcome
	}

	contactRequestsQueryUpdate(prev => ({ ...prev, incoming: prev.incoming.filter(r => r.uuid !== uuid) }))

	return { status: "success" }
}

export async function cancelRequest(uuid: string): Promise<VoidActionOutcome> {
	const outcome = await attemptOp(sdkApi.cancelContactRequest(uuid))

	if (outcome.status === "error") {
		return outcome
	}

	contactRequestsQueryUpdate(prev => ({ ...prev, outgoing: prev.outgoing.filter(r => r.uuid !== uuid) }))

	return { status: "success" }
}

// ── Message (starts or opens a 1:1 chat with the contact) ────────────────

export interface MessageContactOptions {
	// Fired once the chat exists (freshly created, or an existing 1:1 the SDK's own create op reused)
	// — the caller's chance to navigate straight into it. Mirrors chats/lib/actions.ts's own
	// beforeCacheRemoval callback shape (leaveChat/deleteChat): the mutation layer never navigates
	// itself, it just reports readiness.
	onChatReady?: (chat: Chat) => void
}

// Reuses the exact same chats/lib/actions.ts create path CreateChatDialog already calls (a single-
// contact array), rather than a parallel "start a chat" implementation living in contacts — there is
// only ever one way this app creates a chat.
export async function messageContact(contact: Contact, opts?: MessageContactOptions): Promise<VoidActionOutcome> {
	const outcome = await createChat([contact])

	if (outcome.status === "error") {
		return { status: "error", dto: outcome.dto }
	}

	opts?.onChatReady?.(outcome.item)

	return { status: "success" }
}

// Block identity — the minimal fields any surface can supply to block someone. A contact carries all of
// them; a chat message sender (block-from-message, no full Contact in hand) carries every field except a
// creation timestamp, which is synthesized. userId is needed so the local blocked-set cross-reference
// (blocking.ts) matches by id, not only email.
export interface BlockIdentity {
	email: string
	userId: bigint
	nickName?: string | undefined
	avatar?: string | undefined
	timestamp?: bigint | undefined
}

// Block by identity — the SDK op is email-keyed (unlike every other contact mutation, which takes a
// uuid), so any caller holding the target's email can block them, contact or not (a group-chat message
// sender need not be in your contacts). The optimistic BlockedContact is synthesized from the identity
// rather than refetched; `timestamp` defaults to now (a block time, not a contact-creation time) and
// self-heals on the next contacts refetch anyway.
export async function blockContactByEmail(identity: BlockIdentity): Promise<VoidActionOutcome> {
	const outcome = await attemptOp(sdkApi.blockContact(identity.email))

	if (outcome.status === "error") {
		return outcome
	}

	// The op's return is a bare uuid string, not a UuidStr — the SDK's own declared return type here
	// is `Promise<string>` (unlike every read op, which hands back a fully-typed record), so the brand
	// is asserted rather than inferred.
	const blocked: BlockedContact = {
		uuid: outcome.item as UuidStr,
		userId: identity.userId,
		email: identity.email,
		// BlockedContact.nickName is non-optional, unlike Contact.nickName.
		nickName: identity.nickName ?? "",
		timestamp: identity.timestamp ?? BigInt(Date.now()),
		...(identity.avatar !== undefined ? { avatar: identity.avatar } : {})
	}

	contactsQueryUpdate(prev => ({
		...prev,
		// Block is email-keyed server-side, so the source-list filter is too (a uuid filter would miss a
		// stale duplicate row sharing this email under a different uuid).
		contacts: prev.contacts.filter(c => c.email !== identity.email),
		blocked: [...prev.blocked.filter(c => c.email !== identity.email), blocked]
	}))

	return { status: "success" }
}

export async function blockContact(contact: Contact): Promise<VoidActionOutcome> {
	return blockContactByEmail(contact)
}

// A participant's block toggle (chat or note participants dialog). Unblock is uuid-keyed, so it needs the
// blocked record the row's flag came from; "stale" (returned synchronously, before any op starts) means
// that record has since left the block list, e.g. unblocked in another tab.
export function toggleParticipantBlocked(
	participant: BlockIdentity,
	blocked: readonly BlockedContact[] | undefined,
	isBlockedNow: boolean
): "stale" | Promise<VoidActionOutcome> {
	if (!isBlockedNow) {
		return blockContactByEmail(participant)
	}

	const blockedUuid = blocked?.find(c => c.userId === participant.userId)?.uuid

	if (blockedUuid === undefined) {
		return "stale"
	}

	return unblockContact(blockedUuid)
}

export async function unblockContact(uuid: string): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.unblockContact(uuid))
		// No reconstructable Contact comes back from unblockContact itself — getContacts is the source
		// of truth for the patch, same shape as sendContactRequest's outgoing read-back above. A rejection
		// here still surfaces as an error outcome even though the unblock already completed server-side
		// (mirrors the mobile client) — the read-back marks the contacts stale, so the stale blocked-list
		// entry self-heals on the next mount or focus.
		await rereadContactList()
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	contactsQueryUpdate(prev => ({ ...prev, blocked: prev.blocked.filter(c => c.uuid !== uuid) }))

	return { status: "success" }
}

export async function removeContact(uuid: string): Promise<VoidActionOutcome> {
	const outcome = await attemptOp(sdkApi.deleteContact(uuid))

	if (outcome.status === "error") {
		return outcome
	}

	contactsQueryUpdate(prev => ({ ...prev, contacts: prev.contacts.filter(c => c.uuid !== uuid) }))

	return { status: "success" }
}
