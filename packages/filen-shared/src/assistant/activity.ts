import { isRecord } from "./internal"
import type { AssistantTool } from "./tool"
import { sanitizeUntrustedText, screenAssistantReply } from "./untrusted"

// What a progress list may show about a call: derived from the tool and its validated arguments only,
// never from what the model wrote around them. Item names are other people's text whenever an item is
// shared, so every string is sanitized (control tokens, invisible and bidi characters), screened like a
// reply (links the user did not type are defanged) and shortened; the UI renders it as plain text.

export const SUBJECT_MAX_CHARS = 48

export function labelText({
	text,
	userMessage,
	canary,
	specialTokens = []
}: {
	text: string
	userMessage: string
	canary?: string
	specialTokens?: readonly string[]
}): string {
	const flat = sanitizeUntrustedText(text, specialTokens).replace(/\s+/g, " ").trim()

	// The reply screen would withhold the whole reply; a label just goes without.
	if (canary !== undefined && flat.includes(canary)) {
		return ""
	}

	const screened = screenAssistantReply({
		reply: flat,
		userMessage
	}).text
	const chars = Array.from(screened)

	return chars.length > SUBJECT_MAX_CHARS
		? `${chars
				.slice(0, SUBJECT_MAX_CHARS - 1)
				.join("")
				.trimEnd()}…`
		: screened
}

// The one thing a call acts on: its single item's name, or its free text (a query, a path, a new name).
// The free text comes first for a call that creates something ("New directory" names the new directory,
// not its parent). Free text is the model's own writing, which other people's text can steer, so it shows
// only when `grounded` finds it in the user's message; otherwise the call keeps its generic label.
// Undefined when the first argument present names several items, an item `name` does not know, or
// ungrounded text.
export function toolCallSubject({
	tool,
	args,
	name,
	grounded,
	userMessage,
	canary,
	specialTokens = []
}: {
	tool: AssistantTool
	args: Record<string, unknown>
	name: (handle: string) => string | undefined
	grounded: (text: string) => boolean
	userMessage: string
	canary?: string
	specialTokens?: readonly string[]
}): string | undefined {
	const label = (text: string) =>
		labelText({
			text,
			userMessage,
			...(canary === undefined ? {} : { canary }),
			specialTokens
		})

	const handleArgs = tool.grounded.handles ?? []
	const textArgs = tool.grounded.text ?? []
	const order = tool.effect === "additive" ? [...textArgs, ...handleArgs] : [...handleArgs, ...textArgs]

	for (const key of order) {
		const value = args[key]

		if (value === undefined) {
			continue
		}

		if (textArgs.includes(key)) {
			if (typeof value !== "string" || !grounded(value)) {
				return undefined
			}

			const text = label(value)

			if (text.length > 0) {
				return text
			}

			continue
		}

		const handles: unknown[] = Array.isArray(value) ? value : [value]
		const [handle] = handles

		if (handles.length !== 1 || typeof handle !== "string") {
			return undefined
		}

		const resolved = name(handle)
		const text = resolved === undefined ? "" : label(resolved)

		return text.length > 0 ? text : undefined
	}

	return undefined
}

// The tools whose result is a list of items: another tool's only list (a sharing status's recipients, a
// storage breakdown) is not what the user asked to count.
const LISTING_TOOLS: ReadonlySet<string> = new Set([
	"search_items",
	"list_directory",
	"recent_items",
	"list_photos",
	"list_section",
	"list_notes",
	"list_chats",
	"find_contacts",
	"list_playlists",
	"open_playlist",
	"get_transfers"
])

// How many items a listing or search returned: its result's only list of records, plus the `offset` a later
// page starts at and a `more` count it reports beyond them; `more: true` marks a list cut off at an unknown
// length.
export function resultItemCount({ tool, result }: { tool: AssistantTool; result: unknown }): { count: number; more: boolean } | undefined {
	if (!LISTING_TOOLS.has(tool.name) || !isRecord(result)) {
		return undefined
	}

	const lists = Object.values(result).filter((value): value is unknown[] => Array.isArray(value) && value.every(isRecord))
	const [list] = lists
	const more = result["more"]
	const offset = result["offset"]
	const counted = (value: unknown) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0)

	if (lists.length !== 1 || list === undefined) {
		return undefined
	}

	return {
		// A page past the end counts as the empty list it is, not as the rows before it.
		count: (list.length > 0 ? counted(offset) : 0) + list.length + counted(more),
		more: more === true
	}
}
