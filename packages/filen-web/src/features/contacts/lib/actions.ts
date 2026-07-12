import type { BlockedContact, Chat, Contact, ContactRequestOut, UuidStr } from "@filen/sdk-rs"
import { sdkApi } from "@/lib/sdk/client"
import { queryClient } from "@/queries/client"
import {
	CONTACTS_QUERY_KEY,
	CONTACT_REQUESTS_QUERY_KEY,
	contactRequestsQueryUpdate,
	contactsQueryUpdate
} from "@/features/contacts/queries/contacts"
import { asErrorDTO } from "@/lib/sdk/errors"
import { runOp, type VoidActionOutcome } from "@/lib/actions/outcome"
import { runBulk, type BulkOutcome } from "@/features/drive/lib/bulk"
import { createChat } from "@/features/chats/lib/actions"

export type { VoidActionOutcome }

// One typed async helper per contact action — zero-`useMutation`: each calls its worker op, then
// (only on success) patches the affected query cache directly. Every helper returns a
// VoidActionOutcome and never throws; LABEL-FIRST error shaping comes from runOp/asErrorDTO, mirrored
// from features/drive/lib/actions.ts. Cache-patch semantics mirror the mobile contacts feature exactly.

export async function sendContactRequest(email: string): Promise<VoidActionOutcome> {
	let outgoing: ContactRequestOut[]
	try {
		// The op's own return (the new request's uuid) is discarded — a fresh listOutgoingContactRequests
		// is the source of truth for the patch, same as the mobile client.
		await runOp(sdkApi.sendContactRequest(email))
		outgoing = await runOp(sdkApi.listOutgoingContactRequests())
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	contactRequestsQueryUpdate(prev => ({ ...prev, outgoing }))

	return { status: "success" }
}

export async function acceptRequest(uuid: string): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.acceptContactRequest(uuid))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	// Immediate feedback: drop the request from incoming without waiting on a refetch.
	contactRequestsQueryUpdate(prev => ({ ...prev, incoming: prev.incoming.filter(r => r.uuid !== uuid) }))

	// The accepted request promotes to a full contact server-side, but the op's return is only a bare
	// uuid — not enough to reconstruct a Contact (nickname/avatar/publicKey/... are unknown here).
	// Invalidating both queries lets a real refetch fill the gap instead of leaving one inconsistent
	// until the next focus/reconnect. Fire-and-forget, same as renameItem's names-cache invalidation in
	// features/drive/lib/actions.ts: the removal above already covers the immediate feedback, and
	// invalidateQueries resolves even when the refetch it triggers fails (the query's own error state
	// absorbs that, not this call's promise).
	void queryClient.invalidateQueries({ queryKey: CONTACTS_QUERY_KEY })
	void queryClient.invalidateQueries({ queryKey: CONTACT_REQUESTS_QUERY_KEY })

	return { status: "success" }
}

export async function denyRequest(uuid: string): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.denyContactRequest(uuid))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	contactRequestsQueryUpdate(prev => ({ ...prev, incoming: prev.incoming.filter(r => r.uuid !== uuid) }))

	return { status: "success" }
}

export async function cancelRequest(uuid: string): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.cancelContactRequest(uuid))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
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
	nickName?: string
	avatar?: string
	timestamp?: bigint
}

// Block by identity — the SDK op is email-keyed (unlike every other contact mutation, which takes a
// uuid), so any caller holding the target's email can block them, contact or not (a group-chat message
// sender need not be in your contacts). The optimistic BlockedContact is synthesized from the identity
// rather than refetched; `timestamp` defaults to now (a block time, not a contact-creation time) and
// self-heals on the next contacts refetch anyway.
export async function blockContactByEmail(identity: BlockIdentity): Promise<VoidActionOutcome> {
	let blockedUuid: string
	try {
		blockedUuid = await runOp(sdkApi.blockContact(identity.email))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	// The op's return is a bare uuid string, not a UuidStr — the SDK's own declared return type here
	// is `Promise<string>` (unlike every read op, which hands back a fully-typed record), so the brand
	// is asserted rather than inferred.
	const blocked: BlockedContact = {
		uuid: blockedUuid as UuidStr,
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
	return blockContactByEmail({
		email: contact.email,
		userId: contact.userId,
		nickName: contact.nickName ?? "",
		timestamp: contact.timestamp,
		...(contact.avatar !== undefined ? { avatar: contact.avatar } : {})
	})
}

export async function unblockContact(uuid: string): Promise<VoidActionOutcome> {
	let contacts: Contact[]
	try {
		await runOp(sdkApi.unblockContact(uuid))
		// No reconstructable Contact comes back from unblockContact itself — getContacts is the source
		// of truth for the patch, same shape as sendContactRequest's outgoing refetch above. A rejection
		// here still surfaces as an error outcome even though the unblock already completed server-side
		// (mirrors the mobile client) — the stale blocked-list entry self-heals on the next focus refetch.
		contacts = await runOp(sdkApi.getContacts())
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	contactsQueryUpdate(prev => ({ ...prev, contacts, blocked: prev.blocked.filter(c => c.uuid !== uuid) }))

	return { status: "success" }
}

export async function removeContact(uuid: string): Promise<VoidActionOutcome> {
	try {
		await runOp(sdkApi.deleteContact(uuid))
	} catch (e) {
		return { status: "error", dto: asErrorDTO(e) }
	}

	contactsQueryUpdate(prev => ({ ...prev, contacts: prev.contacts.filter(c => c.uuid !== uuid) }))

	return { status: "success" }
}

// ── Bulk ─────────────────────────────────────────────────────────────────

// Adapts any of the never-throwing helpers above into runBulk's throw-on-failure per-item contract,
// so a bulk action reuses the exact same op + patch as its singular counterpart instead of
// duplicating either. Generic over the item type since accept/deny/cancel/remove/block/unblock each
// bulk over a differently-shaped record (ContactRequestIn/Out, Contact, BlockedContact) — the caller
// supplies both the list and which singular helper to apply per item.
export function runContactsBulk<T>(items: T[], perItem: (item: T) => Promise<VoidActionOutcome>): Promise<BulkOutcome<T>> {
	return runBulk(items, async item => {
		const outcome = await perItem(item)
		if (outcome.status === "error") {
			// Mirrors runOp: a plain ErrorDTO thrown intact is what runBulk's per-item catch (and the
			// BulkFailure.error it produces) expects to receive.
			// eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberate, see above
			throw outcome.dto
		}
	})
}
