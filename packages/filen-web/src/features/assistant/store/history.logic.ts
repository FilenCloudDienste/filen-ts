import { type } from "arktype"
import { compareIds } from "@filen/shared"
import {
	applyAssistantEvent,
	proposalEntryId,
	replyEntryId,
	stepsEntryId,
	INITIAL_TRANSCRIPT_STATE,
	type ProposalStatus,
	type TranscriptEntry,
	type TranscriptStep
} from "@/features/assistant/store/transcript"
import { clipText } from "@/features/assistant/tools/format"
import type { AssistantExchange } from "@/features/assistant/types"

// Saved conversations, as plain text. A turn is a few KB (the message, replies capped by the model's
// output budget, the step labels), so 100 conversations within 4 MiB keep the kv store and the index read
// small; one conversation keeps at most 256 KiB, its oldest turns dropped first, so a single very long one
// cannot push all the others out. Over either total, the conversations active longest ago go first.
export const HISTORY_MAX_CONVERSATIONS = 100
export const HISTORY_MAX_TOTAL_BYTES = 4 * 1024 * 1024
export const HISTORY_MAX_CONVERSATION_BYTES = 256 * 1024
// Far past what fits the model's context; only a pasted wall of text reaches it.
const MAX_TEXT_CHARS = 16_384
const TITLE_CHARS = 60

export const HISTORY_KV_PREFIX = "assistant.v1.history."

// How long saved conversations are kept after their last activity. Off saves none; Forever keeps them within the
// caps above only. Stored outside the history prefix, so clearing the history keeps it.
export const HISTORY_RETENTION_VALUES = ["off", "1d", "7d", "30d", "forever"] as const

export type HistoryRetention = (typeof HISTORY_RETENTION_VALUES)[number]

export const historyRetentionSchema = type.enumerated(...HISTORY_RETENTION_VALUES)

export const HISTORY_RETENTION_KEY = "assistant.v1.retention"

const DAY_MS = 24 * 60 * 60 * 1000

const RETENTION_DAYS: Record<HistoryRetention, number | null> = { off: null, "1d": 1, "7d": 7, "30d": 30, forever: null }

// Whether conversations go by age (Off clears everything instead).
export function retentionLimitsAge(retention: HistoryRetention): boolean {
	return RETENTION_DAYS[retention] !== null
}

// How many of the held conversations switching to `next` removes: all of them for Off, else those last active
// before its cutoff except `keep` (the one on screen, which pruning spares). Null when none are held (the list was
// never opened): then whether any goes is unknown without a read, and only a stricter choice can remove any.
export function retentionRemovals(
	metas: readonly ConversationMeta[] | null,
	next: HistoryRetention,
	now: number,
	keep: string | null
): number | null {
	if (metas === null) {
		return null
	}

	if (next === "off") {
		return metas.length
	}

	const cutoff = retentionCutoff(next, now)

	return cutoff === null ? 0 : metas.filter(meta => meta.updatedAt < cutoff && meta.id !== keep).length
}

// Whether `next` keeps conversations for less time than `current`.
export function retentionIsStricter(next: HistoryRetention, current: HistoryRetention): boolean {
	return HISTORY_RETENTION_VALUES.indexOf(next) < HISTORY_RETENTION_VALUES.indexOf(current)
}

// Conversations last active before this go; null when age removes none.
export function retentionCutoff(retention: HistoryRetention, now: number): number | null {
	const days = RETENTION_DAYS[retention]

	return days === null ? null : now - days * DAY_MS
}

// The index row is small and read for the whole list; the body only when the conversation opens. The
// body is written first, so an index row always has its body.
export function historyMetaKey(id: string): string {
	return `${HISTORY_KV_PREFIX}meta.${id}`
}

export const HISTORY_META_PREFIX = historyMetaKey("")

export function historyBodyKey(id: string): string {
	return `${HISTORY_KV_PREFIX}body.${id}`
}

const HISTORY_BODY_PREFIX = historyBodyKey("")

// The conversation a history row belongs to; null for a key of neither kind.
export function historyRowId(key: string): string | null {
	for (const prefix of [HISTORY_META_PREFIX, HISTORY_BODY_PREFIX]) {
		if (key.startsWith(prefix) && key.length > prefix.length) {
			return key.slice(prefix.length)
		}
	}

	return null
}

// `rev` changes with every save: a tab overwrites a conversation only while the stored rev is the one it
// last wrote or read.
export const conversationMetaSchema = type({
	id: "string",
	title: "string",
	createdAt: "number",
	updatedAt: "number",
	bytes: "number",
	rev: "string"
})

export type ConversationMeta = typeof conversationMetaSchema.infer

// The history list's order: most recently active first, then id, so two saved in the same millisecond keep one
// order whatever order the index was read in.
export function compareConversationsNewestFirst(a: ConversationMeta, b: ConversationMeta): number {
	return b.updatedAt - a.updatedAt || compareIds(a.id, b.id)
}

const STEP_STATUS = "'active' | 'queued' | 'waiting' | 'done' | 'failed' | 'stopped' | 'discarded'"
// Too many alternatives for one arktype string: its type instantiation runs too deep.
const STORED_ROUTE = type
	.enumerated(
		"files",
		"insights",
		"shared",
		"organize",
		"batch",
		"trash",
		"restore",
		"notes",
		"chats",
		"audio",
		"navigation",
		"help",
		"answer"
	)
	.or("null")
const STORED_PROPOSAL_ACTION = type.enumerated(
	"draft-message",
	"move",
	"copy",
	"trash",
	"restore",
	"rename",
	"batch-rename",
	"organize-by-date",
	"favorite",
	"unfavorite",
	"create-directory",
	"create-note",
	"note-flags",
	"add-to-playlist"
)
const STEP_TIMES = { status: STEP_STATUS, startedAt: "number", endedAt: "number | null" } as const

// What a step showed: its kind, status, subject and counts, never a tool's output.
const storedStepSchema = type({ kind: "'loading' | 'thinking' | 'replying'", ...STEP_TIMES })
	.or({
		kind: "'routing'",
		route: STORED_ROUTE,
		...STEP_TIMES
	})
	.or({
		kind: "'tool'",
		tool: "string",
		subject: "string | null",
		resultCount: "number | null",
		resultMore: "boolean",
		failure: "'invalid' | 'error' | 'blocked' | 'declined' | 'repeated' | null",
		...STEP_TIMES
	})

type StoredStep = typeof storedStepSchema.infer

// Entries carry their turn's position instead of ids: restoring mints fresh ids, so a restored turn can
// never share one with a turn of this page's session.
const storedEntrySchema = type({ kind: "'user'", turn: "number", text: "string" })
	.or({ kind: "'reply'", turn: "number", text: "string", "withheld?": "boolean" })
	.or({
		kind: "'steps'",
		turn: "number",
		steps: storedStepSchema.array(),
		startedAt: "number",
		lastAt: "number",
		outcome: "'complete' | 'cancelled' | 'failed'"
	})
	.or({
		kind: "'proposal'",
		turn: "number",
		action: STORED_PROPOSAL_ACTION,
		targets: type({ handle: "string", name: "string", "recipients?": "string[]" }).array(),
		destination: "string | null",
		text: "Record<string, string>",
		// Never "pending" or "running": see storedProposalStatus.
		status: "'done' | 'failed' | 'cancelled' | 'expired' | 'interrupted'"
	})
	.or({
		kind: "'turnEnd'",
		turn: "number",
		outcome: "'cancelled' | 'model-unavailable' | 'context-full' | 'message-too-long' | 'no-reply' | 'expired' | 'failed'"
	})

type StoredEntry = typeof storedEntrySchema.infer

export const conversationBodySchema = type({
	v: "1",
	rev: "string",
	entries: storedEntrySchema.array(),
	history: type({ user: "string", reply: "string" }).array()
})

export type ConversationBody = typeof conversationBodySchema.infer

export type ConversationContent = Pick<ConversationBody, "entries" | "history">

export interface ConversationSnapshot {
	entries: readonly TranscriptEntry[]
	activeTurnId: string | null
	history: readonly AssistantExchange[]
}

function capText(text: string): string {
	const capped = clipText(text, MAX_TEXT_CHARS)

	return capped.truncated ? `${capped.text}…` : text
}

const encoder = new TextEncoder()

export function utf8Bytes(text: string): number {
	return encoder.encode(text).byteLength
}

function storedStep(step: TranscriptStep): StoredStep {
	const times = { status: step.status, startedAt: step.startedAt, endedAt: step.endedAt }

	switch (step.kind) {
		case "routing":
			return { kind: "routing", route: step.route, ...times }
		case "tool":
			return {
				kind: "tool",
				tool: step.tool,
				subject: step.subject,
				resultCount: step.resultCount,
				resultMore: step.resultMore,
				failure: step.failure,
				...times
			}
		default:
			return { kind: step.kind, ...times }
	}
}

// A card can only be confirmed by the live turn that proposed it, so a saved one is never actionable: one
// still waiting is stored as expired. One confirmed and still running runs to its end after a switch, but
// its outcome reaches only the live transcript, so it is stored as interrupted, never as undone.
function storedProposalStatus(status: ProposalStatus): Exclude<ProposalStatus, "pending" | "running"> {
	switch (status) {
		case "pending":
			return "expired"
		case "running":
			return "interrupted"
		default:
			return status
	}
}

function storedEntry(entry: TranscriptEntry, turn: number): StoredEntry {
	switch (entry.kind) {
		case "user":
			return { kind: entry.kind, turn, text: capText(entry.text) }
		case "reply":
			return { kind: entry.kind, turn, text: capText(entry.text), ...(entry.withheld === true ? { withheld: true } : {}) }
		case "steps":
			return {
				kind: "steps",
				turn,
				steps: entry.steps.map(storedStep),
				startedAt: entry.startedAt,
				lastAt: entry.lastAt,
				outcome: entry.outcome ?? "cancelled"
			}
		case "proposal":
			return {
				kind: "proposal",
				turn,
				action: entry.proposal.action,
				targets: entry.proposal.targets.map(({ handle, name, recipients }) => ({
					handle,
					name,
					...(recipients === undefined ? {} : { recipients: [...recipients] })
				})),
				destination: entry.proposal.destination,
				text: Object.fromEntries(Object.entries(entry.proposal.text).map(([key, value]) => [key, capText(value)])),
				status: storedProposalStatus(entry.status)
			}
		case "turnEnd":
			return { kind: "turnEnd", turn, outcome: entry.outcome }
	}
}

// Drops the oldest turns, then the oldest exchanges of the model's history, until the conversation fits
// its cap; the newest turn and exchange always stay.
function fitConversation(entries: StoredEntry[], history: AssistantExchange[]): ConversationContent {
	const turnBytes = new Map<number, number>()
	let total = 0

	for (const entry of entries) {
		const bytes = utf8Bytes(JSON.stringify(entry))

		turnBytes.set(entry.turn, (turnBytes.get(entry.turn) ?? 0) + bytes)
		total += bytes
	}

	const exchangeBytes = history.map(exchange => utf8Bytes(JSON.stringify(exchange)))

	total += exchangeBytes.reduce((sum, bytes) => sum + bytes, 0)

	const dropped = new Set<number>()
	const turns = [...turnBytes.keys()]
	let firstExchange = 0

	for (const turn of turns.slice(0, -1)) {
		if (total <= HISTORY_MAX_CONVERSATION_BYTES) {
			break
		}

		dropped.add(turn)
		total -= turnBytes.get(turn) ?? 0
	}

	while (total > HISTORY_MAX_CONVERSATION_BYTES && firstExchange < history.length - 1) {
		total -= exchangeBytes[firstExchange] ?? 0
		firstExchange++
	}

	return {
		entries: dropped.size === 0 ? entries : entries.filter(entry => !dropped.has(entry.turn)),
		history: history.slice(firstExchange)
	}
}

// The conversation as it is saved. A turn still running is saved as stopped: nothing of it is resumable,
// and the tab may close before it ends.
export function serializeConversation(snapshot: ConversationSnapshot, now: number): ConversationContent {
	const entries =
		snapshot.activeTurnId === null
			? snapshot.entries
			: applyAssistantEvent(
					{ ...INITIAL_TRANSCRIPT_STATE, entries: snapshot.entries, activeTurnId: snapshot.activeTurnId },
					{ type: "turn-end", turnId: snapshot.activeTurnId, at: now, outcome: "cancelled" }
				).entries
	const turns = new Map<string, number>()

	for (const entry of entries) {
		if (entry.kind === "user") {
			turns.set(entry.turnId, turns.size)
		}
	}

	const stored: StoredEntry[] = []

	for (const entry of entries) {
		const turn = turns.get(entry.turnId)

		if (turn !== undefined) {
			stored.push(storedEntry(entry, turn))
		}
	}

	return fitConversation(
		stored,
		snapshot.history.map(({ user, reply }) => ({ user: capText(user), reply: capText(reply) }))
	)
}

function restoredStep(step: StoredStep, id: string): TranscriptStep {
	return { id, progress: null, ...step }
}

// Back into transcript entries, under ids minted from `prefix` (unique per restore). Every restored card is
// inert: the store keeps its saved, settled status, and no session holds a proposal under its new id.
export function restoreConversation(
	content: ConversationContent,
	prefix: string
): { entries: TranscriptEntry[]; history: AssistantExchange[] } {
	const entries: TranscriptEntry[] = []
	// Per turn and kind: a turn's replies are r0, r1… and its cards p0, p1…
	const counts = new Map<string, number>()

	for (const entry of content.entries) {
		const turnId = `${prefix}-${String(entry.turn)}`
		const countKey = `${String(entry.turn)}:${entry.kind}`
		const index = counts.get(countKey) ?? 0

		counts.set(countKey, index + 1)

		switch (entry.kind) {
			case "user":
				entries.push({ kind: "user", id: `user:${turnId}`, turnId, text: entry.text })
				break
			case "reply":
				entries.push({
					kind: "reply",
					id: replyEntryId(`${turnId}:r${String(index)}`),
					turnId,
					text: entry.text,
					final: true,
					...(entry.withheld === true ? { withheld: true } : {})
				})
				break
			case "steps":
				entries.push({
					kind: "steps",
					id: stepsEntryId(turnId),
					turnId,
					steps: entry.steps.map((step, stepIndex) => restoredStep(step, `${turnId}:s${String(stepIndex)}`)),
					startedAt: entry.startedAt,
					lastAt: entry.lastAt,
					outcome: entry.outcome,
					expanded: null
				})
				break
			case "proposal": {
				const id = `${turnId}:p${String(index)}`

				entries.push({
					kind: "proposal",
					id: proposalEntryId(id),
					turnId,
					proposal: { id, action: entry.action, targets: entry.targets, destination: entry.destination, text: entry.text },
					status: entry.status
				})
				break
			}
			case "turnEnd":
				entries.push({ kind: "turnEnd", id: `turnEnd:${turnId}`, turnId, outcome: entry.outcome })
				break
		}
	}

	return { entries, history: content.history.map(({ user, reply }) => ({ user, reply })) }
}

// The first message, on one line, cut at a word near the limit. No model call: it would cost a turn.
export function conversationTitle(content: ConversationContent): string {
	const first = content.entries.find(entry => entry.kind === "user")
	const text = first?.kind === "user" ? first.text.replace(/\s+/g, " ").trim() : ""

	if (text.length <= TITLE_CHARS) {
		return text
	}

	const cut = clipText(text, TITLE_CHARS).text
	const space = cut.lastIndexOf(" ")

	return `${(space > TITLE_CHARS / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

// The conversations to delete: every one last active before `cutoff` (retentionCutoff), then, active longest ago
// first, as many as the rest need to fit the budget. `keep` (the one just saved, the one on screen) is never among
// them.
export function planHistoryPrune(metas: readonly ConversationMeta[], keep: ReadonlySet<string>, cutoff: number | null = null): string[] {
	const oldestFirst = [...metas].sort((a, b) => compareConversationsNewestFirst(b, a))
	let count = oldestFirst.length
	let bytes = oldestFirst.reduce((sum, meta) => sum + meta.bytes, 0)
	const pruned: string[] = []

	for (const meta of oldestFirst) {
		const expired = cutoff !== null && meta.updatedAt < cutoff

		if (!expired && count <= HISTORY_MAX_CONVERSATIONS && bytes <= HISTORY_MAX_TOTAL_BYTES) {
			break
		}

		if (keep.has(meta.id)) {
			continue
		}

		pruned.push(meta.id)
		count--
		bytes -= meta.bytes
	}

	return pruned
}

export type HistoryGroup = "today" | "yesterday" | "previous7Days" | "older"

function startOfDay(at: number, daysBack: number): number {
	const date = new Date(at)

	date.setHours(0, 0, 0, 0)
	date.setDate(date.getDate() - daysBack)

	return date.getTime()
}

// By local calendar day of the last activity, newest first; empty groups are left out.
export function groupConversations(
	metas: readonly ConversationMeta[],
	now: number
): { group: HistoryGroup; conversations: ConversationMeta[] }[] {
	const today = startOfDay(now, 0)
	const yesterday = startOfDay(now, 1)
	const week = startOfDay(now, 7)
	const groups = new Map<HistoryGroup, ConversationMeta[]>()

	for (const meta of [...metas].sort(compareConversationsNewestFirst)) {
		const group: HistoryGroup =
			meta.updatedAt >= today
				? "today"
				: meta.updatedAt >= yesterday
					? "yesterday"
					: meta.updatedAt >= week
						? "previous7Days"
						: "older"
		const list = groups.get(group)

		if (list === undefined) {
			groups.set(group, [meta])
		} else {
			list.push(meta)
		}
	}

	return [...groups].map(([group, conversations]) => ({ group, conversations }))
}
