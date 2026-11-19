import type { Chat } from "@filen/sdk-rs"
import { isBlocked } from "@filen/shared"
import {
	composerBusyMessage,
	CONTACT_NEEDS_WORDS,
	CONTACT_WITHOUT_CHAT_NOTE,
	DRAFTED_NOTE,
	listRest,
	matchScore,
	NO_CONTACT_NOTE,
	sanitizeUntrustedText,
	searchTokens
} from "@filen/shared/assistant"
import { contactsQueryRead } from "@/features/contacts/queries/contacts"
import { chatsQueryRead } from "@/features/chats/queries/chats"
import { chatMessagesQueryGet, chatMessagesQueryRead } from "@/features/chats/queries/chatMessages"
import { chatHasUnread } from "@/features/chats/lib/unread.logic"
import { chatsWithoutBlockedOneOnOne, filterChats } from "@/features/chats/components/chatsSidebar.logic"
import { isChatUndecryptable, messageSenderName, otherParticipants } from "@/features/chats/lib/sort"
import { isOwnMessage, isSenderBlocked } from "@/features/chats/lib/sender"
import { isOverLimit } from "@/features/chats/lib/composer.logic"
import { loadDraft } from "@/features/chats/lib/drafts"
import { useChatComposerStore } from "@/features/chats/store/useChatComposer"
import { i18n } from "@/lib/i18n"
import { assistantRouter, navigateChecked } from "@/features/assistant/tools/navigation"
import {
	blockedUsers,
	chatName,
	currentUserId,
	entityVisible,
	freshChat,
	optionalString,
	participantName,
	requiredString,
	resolveHandle,
	type ToolAdapter,
	type ToolScope
} from "@/features/assistant/tools/entities"
import { AssistantToolError, clipText, isoDate, throwIfStopped } from "@/features/assistant/tools/format"

const LIST_LIMIT = 30
const DEFAULT_MESSAGES = 20
const MAX_MESSAGES = 50
const MESSAGE_MAX_CHARS = 600
// Less room than this left, an older message is left out rather than cut to a fragment.
const MESSAGE_MIN_CHARS = 80
export const CHAT_MAX_CHARS = 6_000

async function resolveChat(scope: ToolScope, handle: string): Promise<Chat> {
	const entity = await resolveHandle(scope, handle, ["chat"])

	if (entity.kind !== "chat") {
		throw new AssistantToolError("Not a chat", { invalid: true })
	}

	const chat = freshChat(entity.chat)

	if (!entityVisible({ kind: "chat", chat })) {
		throw new AssistantToolError("This chat is not available")
	}

	if (isChatUndecryptable(chat)) {
		throw new AssistantToolError("This chat cannot be decrypted")
	}

	return chat
}

// The sidebar's own list, in its order; a query matches the chat's name and its participants' names word by
// word, both sides folded the same way ("joao" finds "João"), the chats matching every word first. A row says
// whether it has unread messages, as the sidebar's dot does (from the cached rows, no request), and when the
// last message is the user's own.
export const listChatsTool: ToolAdapter = async (input, scope) => {
	const userId = currentUserId()
	const blocked = blockedUsers()
	const visible = chatsWithoutBlockedOneOnOne(await chatsQueryRead(), userId, blocked)
	const tokens = searchTokens(optionalString(input, "query") ?? "")
	const listed = filterChats(visible, "", userId, i18n.t("chats:chatJustYou"), blocked)
	const chats =
		tokens.length === 0
			? listed
			: listed
					.map(chat => ({
						chat,
						score: matchScore([chatName(chat), ...otherParticipants(chat, userId).map(participantName)].join(" "), tokens)
					}))
					.filter(({ score }) => score > 0)
					.toSorted((a, b) => b.score - a.score)
					.map(({ chat }) => chat)

	return {
		value: {
			chats: chats.slice(0, LIST_LIMIT).map(chat => {
				const name = chatName(chat)
				const participants = otherParticipants(chat, userId).map(participantName)

				return {
					handle: scope.show({ kind: "chat", chat }, name),
					name,
					// A one-on-one chat is named after the other person, so the list would only repeat the name.
					...(participants.length === 1 && participants[0] === name ? {} : { participants }),
					...(chat.lastMessage === undefined ? {} : { lastActivity: isoDate(chat.lastMessage.sentTimestamp) }),
					...(chat.lastMessage !== undefined && isOwnMessage(chat.lastMessage, userId) ? { lastFrom: "you" } : {}),
					...(chatHasUnread(chat, userId, blocked, chatMessagesQueryGet) ? { unread: true } : {})
				}
			}),
			...listRest(chats.length, LIST_LIMIT)
		}
	}
}

const CONTACT_LIMIT = 10

function localPart(email: string): string {
	const at = email.indexOf("@")

	return at === -1 ? email : email.slice(0, at)
}

const ADDRESS = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/u

// The Contacts screen's own list (blocked users never). An address in the query matches only that address;
// words must all match the name or the address before its "@", so a shared domain or a near miss lists no one
// else: a returned chat handle grounds a draft, and the recipient has to be the one the user named. A contact's
// one-on-one chat comes from the sidebar's own list.
export const findContactsTool: ToolAdapter = async (input, scope) => {
	const query = requiredString(input, "query")
	const address = ADDRESS.exec(query)?.[0].toLowerCase()
	const tokens = searchTokens(query)

	if (address === undefined && tokens.length === 0) {
		throw new AssistantToolError(CONTACT_NEEDS_WORDS, { invalid: true })
	}

	const [{ contacts }, chats] = await Promise.all([contactsQueryRead(), chatsQueryRead()])
	const userId = currentUserId()
	const blocked = blockedUsers()
	const visibleChats = chatsWithoutBlockedOneOnOne(chats, userId, blocked)
	const matches = contacts.filter(
		contact =>
			!isBlocked(contact, blocked) &&
			(address === undefined
				? matchScore(`${participantName(contact)} ${localPart(contact.email)}`, tokens) === tokens.length
				: contact.email.toLowerCase() === address)
	)
	const rows = matches.slice(0, CONTACT_LIMIT).map(contact => {
		const chat = visibleChats.find(candidate => {
			const others = otherParticipants(candidate, userId)

			return others.length === 1 && others[0]?.userId === contact.userId && !isChatUndecryptable(candidate)
		})

		return {
			name: participantName(contact),
			email: contact.email,
			...(chat === undefined ? {} : { chat: scope.show({ kind: "chat", chat }, chatName(chat)) })
		}
	})

	return {
		value: {
			contacts: rows,
			...listRest(matches.length, CONTACT_LIMIT),
			...(rows.length === 0
				? { note: NO_CONTACT_NOTE }
				: rows.some(row => row.chat === undefined)
					? { note: CONTACT_WITHOUT_CHAT_NOTE }
					: {})
		}
	}
}

// The thread's newest messages from its own cache, as the open thread shows them: a blocked sender's
// text stays hidden. Reading never marks the chat read.
export const readChatTool: ToolAdapter = async (input, scope) => {
	const chat = await resolveChat(scope, requiredString(input, "handle"))
	const requested = typeof input["limit"] === "number" && input["limit"] > 0 ? Math.floor(input["limit"]) : DEFAULT_MESSAGES
	const limit = Math.min(requested, MAX_MESSAGES)
	const userId = currentUserId()
	const blocked = blockedUsers()
	const name = chatName(chat)
	const messages = (await chatMessagesQueryRead(chat.uuid)).slice(-limit)
	let budget = CHAT_MAX_CHARS
	let truncated = false
	const rows: { from: string; text: string; sent: string }[] = []

	// Newest first against the budget, so a long backlog drops its oldest messages. A message cut to fit ends
	// in "…", so a summary does not read half a sentence as all that was said.
	for (const message of [...messages].reverse()) {
		const full = isSenderBlocked(message, blocked) ? "(hidden: blocked sender)" : (message.message ?? "(cannot decrypt)")

		if (full.length > budget && budget < MESSAGE_MIN_CHARS) {
			truncated = true
			break
		}

		const clipped = clipText(full, Math.min(MESSAGE_MAX_CHARS, budget))
		const text = clipped.truncated ? `${clipped.text}…` : clipped.text

		budget -= text.length
		rows.unshift({
			// As the extraction prompt names the user's own messages.
			from: isOwnMessage(message, userId) ? "me" : messageSenderName(message),
			text,
			sent: isoDate(message.sentTimestamp)
		})
	}

	return {
		value: {
			chat: { handle: scope.show({ kind: "chat", chat }, name), name },
			messages: rows,
			...(truncated ? { truncated: true } : {})
		}
	}
}

export const openChatTool: ToolAdapter = async (input, scope) => {
	const chat = await resolveChat(scope, requiredString(input, "handle"))
	const router = assistantRouter()

	if (router === null) {
		throw new AssistantToolError("The app cannot navigate right now")
	}

	await navigateChecked({
		router,
		navigate: () => router.navigate({ to: "/chats/$uuid", params: { uuid: chat.uuid } }),
		landed: pathname => pathname === `/chats/${chat.uuid}`,
		signal: scope.signal
	})

	return { value: { opened: chatName(chat) } }
}

// The text a draft puts into the composer: what the card shows and what lands, with invisible and bidi
// characters and template control tokens removed, so the card cannot show one message and send another.
// Joiners that shape a word (Persian, Indic scripts) or draw an emoji stay: they change what the card shows.
export function draftText(text: string): string {
	return sanitizeUntrustedText(text, [], { keepJoiners: true })
}

// Why a draft cannot land, checked before the card shows (and again after the click, for a race): the
// user is never asked to confirm a draft that would then fail.
export async function draftProblem({ chat, text }: { chat: Chat; text: string }): Promise<string | null> {
	if (text.trim().length === 0) {
		return "The message is empty"
	}

	if (isOverLimit(text)) {
		return "The message is too long"
	}

	const entry = useChatComposerStore.getState().entries[chat.uuid]
	const saved = entry === undefined ? await loadDraft(chat.uuid) : ""

	if ((entry !== undefined && (entry.draft.trim().length > 0 || entry.mode.kind !== "new")) || saved.trim().length > 0) {
		return composerBusyMessage(chatName(chat))
	}

	return null
}

export async function draftChatProblem(scope: ToolScope, input: Record<string, unknown>): Promise<string | null> {
	return draftProblem({ chat: await resolveChat(scope, requiredString(input, "chat")), text: draftText(requiredString(input, "text")) })
}

// Runs only after the user confirmed the draft. The text goes into the composer exactly as the user's
// own typing would (its store, mirrored to disk by the composer) and the thread opens; the user sends it.
// Text the user already left in that composer is never overwritten.
export const draftChatMessageTool: ToolAdapter = async (input, scope) => {
	const chat = await resolveChat(scope, requiredString(input, "chat"))
	const text = draftText(requiredString(input, "text"))
	const name = chatName(chat)
	const router = assistantRouter()

	if (router === null) {
		throw new AssistantToolError("The app cannot navigate right now")
	}

	const problem = await draftProblem({ chat, text })

	if (problem !== null) {
		throw new AssistantToolError(problem)
	}

	// The draft is written only once the thread is open: a navigation a dialog refused leaves no draft behind.
	await navigateChecked({
		router,
		navigate: () => router.navigate({ to: "/chats/$uuid", params: { uuid: chat.uuid } }),
		landed: pathname => pathname === `/chats/${chat.uuid}`,
		signal: scope.signal
	})

	const raced = await draftProblem({ chat, text })

	if (raced !== null) {
		throw new AssistantToolError(raced)
	}

	// Signed out meanwhile: the call already reads as failed, so nothing may land.
	throwIfStopped(scope)
	useChatComposerStore.getState().setDraft(chat.uuid, text)

	return {
		value: { drafted: true, chat: name, note: DRAFTED_NOTE }
	}
}
