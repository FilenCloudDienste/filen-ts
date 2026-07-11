import type { ChatMessage, ChatMessagePartial, ChatParticipant } from "@filen/sdk-rs"
import { contactDisplayName } from "@/features/contacts/components/contactsList.logic"
import { searchEmoji, type EmojiSuggestion } from "@/features/chats/lib/emoji"

// Pure, testable core of the chat composer — a port of filen-mobile's input send()/autocomplete logic
// (features/chats/components/chat/input/*). No React/store/IO here; composer.tsx is the thin shell that
// wires these to a <textarea>, the composer store and the send outbox.

// MAX_CHAT_SIZE is 1024*64 = 65536; the client caps a message body 64 chars below that (old-web's
// MAX_CHAT_SIZE-64), leaving headroom the SDK also enforces server-side. Sends over the cap are BLOCKED
// (button disabled + a near-limit counter), never truncated.
export const MAX_CHAT_MESSAGE_LENGTH = 65472
// Surface the remaining-char counter once within this many chars of the cap (quiet until it matters).
export const CHAR_COUNTER_THRESHOLD = 512

export function isOverLimit(value: string): boolean {
	return value.length > MAX_CHAT_MESSAGE_LENGTH
}

export function remainingChars(value: string): number {
	return MAX_CHAT_MESSAGE_LENGTH - value.length
}

export function shouldShowCounter(value: string): boolean {
	return value.length >= MAX_CHAT_MESSAGE_LENGTH - CHAR_COUNTER_THRESHOLD
}

// Send is allowed on any non-blank, within-limit body. NOT gated on connectivity — an offline send is
// the whole point of the outbox (it queues + persists, then flushes on reconnect).
export function canSend(value: string): boolean {
	return value.trim().length > 0 && !isOverLimit(value)
}

// Inserts a just-created attachment public-link url at the END of the current draft — mobile/old-web
// both append rather than caret-inserting an attachment (unlike mention/emoji, which replace the
// in-progress trigger token at the caret). A blank draft becomes just the url; a non-blank one gets a
// single separating space (never a newline — the composer is a single logical message, and a bare url
// on its own trailing token is exactly what embeds.logic.ts's classifier needs to recognize it later).
export function appendAttachmentUrl(draft: string, url: string): string {
	const trimmedEnd = draft.replace(/\s+$/, "")

	return trimmedEnd.length === 0 ? url : `${trimmedEnd} ${url}`
}

// Enter sends, Shift+Enter inserts a newline (the browser default). null when it isn't the Enter key.
export function enterIntent(event: { key: string; shiftKey: boolean }): "send" | "newline" | null {
	if (event.key !== "Enter") {
		return null
	}

	return event.shiftKey ? "newline" : "send"
}

// ArrowUp in an EMPTY composer edits the last own message (old-web affordance; mobile has no equivalent
// — kept because the synthesis flags it as a small, loved web power-shortcut). Only fires on a truly
// empty input so it never hijacks caret navigation inside a draft.
export function shouldEditLastOnArrowUp(value: string): boolean {
	return value.length === 0
}

// The composer's per-chat mode. "reply" pins a quoted target above the input (embedded on the send as a
// denormalized ChatMessagePartial); "edit" loads a committed own message's text for an in-place edit
// (online-best-effort, NOT outbox-queued — parity with mobile/old-web, synthesis §1g).
export type ChatComposerMode = { kind: "new" } | { kind: "reply"; message: ChatMessage } | { kind: "edit"; message: ChatMessage }

export const NEW_MODE: ChatComposerMode = { kind: "new" }

// Denormalized reply snapshot embedded in the send (uuid + sender fields + body), mirroring mobile. Only
// the load-bearing subset of ChatMessagePartial — exactOptionalPropertyTypes: absent avatar OMITS the key.
export function buildReplyPartial(message: ChatMessage): ChatMessagePartial {
	const base = {
		uuid: message.uuid,
		senderId: message.senderId,
		senderEmail: message.senderEmail,
		senderNickName: message.senderNickName
	} satisfies Omit<ChatMessagePartial, "senderAvatar" | "message">

	return {
		...base,
		...(message.senderAvatar !== undefined ? { senderAvatar: message.senderAvatar } : {}),
		...(message.message !== undefined ? { message: message.message } : {})
	}
}

// ── Autocomplete: mention (`@`) + emoji (`:`) ────────────────────────────────────────────────────────
// A trigger is "active" when, scanning back from the caret, the nearest trigger char sits at the start of
// the input or right after whitespace, and the token between it and the caret has no whitespace. This is
// the web-native equivalent of mobile's findClosestIndexString slice — same intent (don't match the `@`
// inside an email, don't keep the popup open once the token is completed with a space).

export interface TriggerQuery {
	// Index of the trigger char in the raw value (where the replacement begins).
	start: number
	// The token AFTER the trigger char, up to the caret (never contains whitespace).
	query: string
}

function activeTrigger(value: string, caret: number, trigger: string): TriggerQuery | null {
	if (caret <= 0 || caret > value.length) {
		return null
	}

	for (let i = caret - 1; i >= 0; i--) {
		const ch = value.charAt(i)

		if (ch === trigger) {
			const before = i === 0 ? "" : value.charAt(i - 1)

			if (i !== 0 && !/\s/.test(before)) {
				// Trigger is glued to a preceding non-space (e.g. the `@` in an email) — not an activation.
				return null
			}

			const query = value.slice(i + 1, caret)

			if (/\s/.test(query)) {
				return null
			}

			return { start: i, query }
		}

		if (/\s/.test(ch)) {
			return null
		}
	}

	return null
}

export function activeMentionQuery(value: string, caret: number): TriggerQuery | null {
	return activeTrigger(value, caret, "@")
}

// Emoji needs at least `minLength` chars after the `:` before it opens (mobile: 3) so a lone `:` or a
// `http:` fragment doesn't spuriously trigger it.
export function activeEmojiQuery(value: string, caret: number, minLength = 2): TriggerQuery | null {
	const found = activeTrigger(value, caret, ":")

	if (found === null || found.query.length < minLength) {
		return null
	}

	return found
}

// Filter conversation participants for a mention token: exclude self, match display-name OR email
// (case-insensitive substring), sort by display name. Empty query lists everyone (minus self).
export function filterMentionParticipants(
	participants: readonly ChatParticipant[],
	query: string,
	currentUserId: bigint | undefined
): ChatParticipant[] {
	const normalized = query.toLowerCase().trim()

	return participants
		.filter(participant => {
			if (currentUserId !== undefined && participant.userId === currentUserId) {
				return false
			}

			if (normalized.length === 0) {
				return true
			}

			return (
				contactDisplayName(participant).toLowerCase().includes(normalized) || participant.email.toLowerCase().includes(normalized)
			)
		})
		.sort((a, b) => {
			const an = contactDisplayName(a).toLowerCase()
			const bn = contactDisplayName(b).toLowerCase()

			return an < bn ? -1 : an > bn ? 1 : 0
		})
}

export function filterEmojiSuggestions(query: string, limit = 10): EmojiSuggestion[] {
	return searchEmoji(query, limit)
}

export interface Replacement {
	value: string
	caret: number
}

// Replace value[start, caret) with `replacement`, returning the new value + caret (placed at the end of
// the inserted text). Shared by mention + emoji application.
function applyReplacement(value: string, start: number, caret: number, replacement: string): Replacement {
	const next = value.slice(0, start) + replacement + value.slice(caret)

	return { value: next, caret: start + replacement.length }
}

// Mentions are stored as `@<email> ` (raw text; MENTION_REGEX re-parses on render) — mobile parity.
export function applyMention(value: string, mention: TriggerQuery, participant: ChatParticipant): Replacement {
	return applyReplacement(value, mention.start, mention.start + 1 + mention.query.length, `@${participant.email} `)
}

// Emoji completes to the native unicode glyph (+ a trailing space), NOT a `:shortcode:` — the web renders
// unicode, so it stores unicode (see emoji.ts header). A trailing space keeps typing flowing.
export function applyEmoji(value: string, emoji: TriggerQuery, glyph: string): Replacement {
	return applyReplacement(value, emoji.start, emoji.start + 1 + emoji.query.length, `${glyph} `)
}

// The last CONFIRMED own message eligible for an ArrowUp edit: newest-first own, decryptable, committed
// message. Operates on the composed (ascending) thread list, so it scans from the end. `excludeUuids`
// carries the still-pending/failed optimistic entries (their uuid IS their inflightId, which the server
// doesn't know) so ArrowUp never loads an uncommitted send into edit mode.
export function lastEditableOwnMessage(
	messages: readonly ChatMessage[],
	currentUserId: bigint | undefined,
	excludeUuids?: ReadonlySet<string>
): ChatMessage | undefined {
	if (currentUserId === undefined) {
		return undefined
	}

	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i]

		if (message === undefined) {
			continue
		}

		if (excludeUuids?.has(message.uuid) === true) {
			continue
		}

		if (message.message !== undefined && BigInt(message.senderId) === currentUserId) {
			return message
		}
	}

	return undefined
}
