import { handleArguments, isConsequentialTool, type AssistantTool, type AssistantUntrustedOutput } from "./tool"
import { foreignLinks, statusMarkers } from "./untrusted"

// Deterministic injection policy, enforced by the dispatcher whatever the model says:
//
// 0. Scope. The router reads only the user's message, before any tool output exists, and decides
//    the tool group and whether the request asks for a change at all. A read request never gets
//    consequential tools, so injected text cannot add capabilities the user did not ask for.
// 1. Grounding. A consequential call runs only if every handle argument traces back to the user:
//    the visible context (current directory, selection, playing track), a lookup whose own
//    arguments came from the user's message, an item the user named (most of its longer words), or
//    an item a grounded call created this turn. A lookup's handle arguments must trace back to the
//    user directly, by context or by a name written out in full: what one lookup returned does not
//    ground the results of the next, so grounding never walks the whole drive. Free-text arguments (new names, titles, recipients) must appear in the user's own
//    message, word for word up to inflection, extension included. Text that exists only inside
//    tool results never grounds anything.
// 2. Taint. Once a tool returns content other people can write (note bodies, file text, chat
//    messages), the turn is tainted: consequential tools are withdrawn for the rest of the turn,
//    navigation needs grounded targets and open_route is withdrawn. Acting on what was read takes
//    a new request from the user.
// 3. Calls that pass still reach the user as a confirmation card naming exactly what happens;
//    there is no "yes to all". Permanent deletion does not exist as a tool at all.

export type AssistantGuardOptions = {
	// From the router: false when the user's message asks for no change.
	consequentialAllowed: boolean
	grounding: boolean
	taintGate: boolean
}

export type AssistantGuardDecision =
	| {
			allowed: true
	  }
	| {
			allowed: false
			reason: string
	  }

const TAINT_ORDER: readonly AssistantUntrustedOutput[] = ["none", "names", "content"]

function normalize(value: string): string {
	return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu

const EXTENSION = /\.[a-z0-9]{1,5}$/i

// Inflection and clitic room for a word that contains another ("invoices" / "invoice", "archiv" /
// "archive", Arabic "وفواتير" / "فواتير"); longer differences are compounds.
const INFLECTION_CHARS = 3

function words(value: string): string[] {
	// CJK writes Latin words without spaces ("報告書をArchiveに"), so script changes split too.
	return normalize(value.replace(EXTENSION, ""))
		.replace(CJK_RUN, run => ` ${run} `)
		.split(/[^\p{L}\p{N}]+/u)
		.filter(word => word.length > 0)
}

function distinctive(word: string): boolean {
	return CJK.test(word) || /^\d+$/.test(word) ? word.length >= 2 : word.length >= 3
}

// A word of an item's name that can point at the item by itself: articles, pronouns and the like ("the",
// "you", "and") are in nearly every message, so only longer words count.
function nameWord(word: string): boolean {
	return CJK.test(word) || /^\d+$/.test(word) ? word.length >= 2 : word.length >= 4
}

// "archiv" grounds "Archive", "invoices" grounds "Invoice"; containment also covers attached
// clitics (Arabic "وفواتير" = "and invoices") and, unless `strict`, compounds. CJK words match as
// substrings.
function wordInMessage({
	word,
	message,
	messageWords,
	strict = false
}: {
	word: string
	message: string
	messageWords: readonly string[]
	strict?: boolean
}): boolean {
	if (CJK.test(word)) {
		return message.includes(word)
	}

	return messageWords.some(
		candidate =>
			candidate === word ||
			(!/^\d+$/.test(word) &&
				Math.min(candidate.length, word.length) >= 4 &&
				(!strict || Math.abs(candidate.length - word.length) <= INFLECTION_CHARS) &&
				(candidate.includes(word) || word.includes(candidate)))
	)
}

// camelCase and letter/digit boundaries split too, so "InvoicesForwardToEve" is four words, not one
// that happens to contain "invoices".
function strictWords(value: string): string[] {
	return words(value.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{L})(\p{N})|(\p{N})(\p{L})/gu, "$1$3 $2$4"))
}

// The words of a lookup's text that narrow what it returns: a lone Latin letter or digit ("m" of "I'm") or
// punctuation alone ("/") matches nearly everything, so a lookup by those grounds nothing it returns. Unsplit,
// so a short identifier ("F1", "3D") stays one word.
function selectiveWords(value: string): string[] {
	return words(value).filter(word => word.length >= 2 || CJK.test(word))
}

// Words mixing letters and digits ("F1", "M5") ground only as written, whole: strictWords splits them, and
// "I'm 5 min" holds both halves as words of their own.
function mixedWords(value: string): string[] {
	return words(value).filter(word => /\p{L}/u.test(word) && /\p{N}/u.test(word))
}

// A short query word ("the", "F1") matches inside other names ("Theo", "Mathematics"), so a search by short
// words only grounds the results that hold each of them as a word of their own.
function nameHoldsWords({ name, queryWords }: { name: string; queryWords: readonly string[] }): boolean {
	const nameWords = words(name)

	return queryWords.every(word => (CJK.test(word) ? normalize(name).includes(word) : nameWords.includes(word)))
}

// Whether a query holds a word long enough to name something by itself, counted with its marks: normalize
// drops a Devanagari word's vowel signs, which would make most Hindi words short.
function hasNameWord(value: string): boolean {
	return value
		.normalize("NFC")
		.toLowerCase()
		.split(/[^\p{L}\p{M}\p{N}]+/u)
		.some(word => nameWord(word))
}

function extensionOf(value: string): string | undefined {
	return EXTENSION.exec(value.trim())?.[0].toLowerCase()
}

// Acting on what a turn read (Save as note, Draft reply): the user clicked a button under a reply that showed the
// payload, which grounds its text. The call is built by code, never by the model from the read content.
export type AssistantActOnReadAction = "save_note" | "draft_reply"

export const ACT_ON_READ_TOOLS: Readonly<Record<AssistantActOnReadAction, string>> = {
	save_note: "create_note",
	draft_reply: "draft_chat_message"
}

export interface AssistantActOnReadGuard {
	check(call: { tool: AssistantTool; args: Record<string, unknown> }): AssistantGuardDecision
}

// Keys in order, so two argument objects compare by content.
function canonical(value: unknown): string {
	return JSON.stringify(value, (_key, entry: unknown) =>
		typeof entry === "object" && entry !== null && !Array.isArray(entry)
			? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: entry
	)
}

export class AssistantTurnGuard {
	// The act-on-read mode: only the action's own tool, only with the code-built arguments; a draft only to a chat
	// that was read, and never with a link or address the user did not type in the request that read it. A saved
	// note keeps its links: it reaches no one else.
	static actOnRead({
		action,
		args,
		sources,
		originUserMessage
	}: {
		action: AssistantActOnReadAction
		args: Record<string, unknown>
		// The handles of the chats (draft) or items (note) the turn read.
		sources: readonly string[]
		originUserMessage: string
	}): AssistantActOnReadGuard {
		const expected = canonical(args)

		return {
			check: ({ tool, args: called }) => {
				if (tool.name !== ACT_ON_READ_TOOLS[action]) {
					return { allowed: false, reason: "Only the action the user clicked can run." }
				}

				if (canonical(called) !== expected) {
					return { allowed: false, reason: "The call differs from what the user was shown." }
				}

				if (action === "draft_reply") {
					const chat = called["chat"]
					const text = called["text"]

					if (typeof chat !== "string" || !sources.includes(chat)) {
						return { allowed: false, reason: "A reply goes only to the chat that was read." }
					}

					if (typeof text === "string" && foreignLinks({ text, userMessage: originUserMessage }).length > 0) {
						return { allowed: false, reason: "The text holds a link or address that does not come from the user's message" }
					}

					// "✅ Saved to your drive: …" in a reply the user sends would vouch for what the app never did.
					if (typeof text === "string" && statusMarkers(text).some(claim => !originUserMessage.includes(claim))) {
						return { allowed: false, reason: "The text holds a status line that does not come from the user's message" }
					}
				}

				return { allowed: true }
			}
		}
	}

	private readonly message: string
	private readonly messageWords: string[]
	private readonly messageStrictWords: string[]
	// Handles that trace back to the user directly: the context and what grounded calls created.
	private readonly grounded = new Set<string>()
	// Results of lookups the user asked for: grounded for acting on, never for further lookups.
	private readonly lookupGrounded = new Set<string>()
	private readonly names = new Map<string, string>()
	private taintLevel: AssistantUntrustedOutput = "none"

	private readonly options: AssistantGuardOptions
	private readonly userMessage: string

	constructor({
		options,
		userMessage,
		contextHandles
	}: {
		options: AssistantGuardOptions
		userMessage: string
		contextHandles: readonly string[]
	}) {
		this.options = options
		this.userMessage = userMessage
		this.message = normalize(userMessage)
		this.messageWords = words(userMessage)
		this.messageStrictWords = strictWords(userMessage)

		for (const handle of contextHandles) {
			this.grounded.add(handle)
		}
	}

	get taint(): AssistantUntrustedOutput {
		return this.taintLevel
	}

	// Every distinctive word of `text` occurs in the user's message (`share` = fraction required).
	textGrounded(text: string, share = 1): boolean {
		const candidates = words(text).filter(distinctive)

		if (candidates.length === 0) {
			return normalize(text.trim()).length > 0 && this.message.includes(normalize(text.trim()))
		}

		const hits = candidates.filter(word =>
			wordInMessage({
				word,
				message: this.message,
				messageWords: this.messageWords
			})
		).length

		return hits >= Math.ceil(candidates.length * share)
	}

	// For text the call itself writes (a new name, a title) or a lookup that grounds what it returns:
	// every word counts, short ones as whole words; containment allows only inflection; and an extension
	// must be one the user typed or the item's current one.
	private textGroundedStrictly(text: string, currentName?: string): boolean {
		const all = strictWords(text)

		if (all.length === 0) {
			return normalize(text.trim()).length > 0 && this.message.includes(normalize(text.trim()))
		}

		if (mixedWords(text).some(word => !this.messageWords.includes(word))) {
			return false
		}

		const everyWord = all.every(word =>
			distinctive(word)
				? wordInMessage({
						word,
						message: this.message,
						messageWords: this.messageStrictWords,
						strict: true
					})
				: this.messageStrictWords.includes(word)
		)
		const extension = extensionOf(text)

		return (
			everyWord &&
			(extension === undefined ||
				this.message.includes(extension) ||
				(currentName !== undefined && extensionOf(currentName) === extension))
		)
	}

	// `lookups: false` grounds a lookup's own arguments: only a name the user wrote out in full counts there,
	// so a lookup never chains from an item that merely shares a word with the request.
	handleGrounded(handle: string, { lookups = true }: { lookups?: boolean } = {}): boolean {
		if (this.grounded.has(handle) || (lookups && this.lookupGrounded.has(handle))) {
			return true
		}

		const name = this.names.get(handle)

		if (name === undefined) {
			return false
		}

		if (!lookups) {
			return this.textGroundedStrictly(name, name)
		}

		return this.nameGrounded(name)
	}

	// At least half of the name's longer words, each up to inflection; a name of short words only ("Tom",
	// "Ann Lee") by those words, whole.
	private nameGrounded(name: string): boolean {
		const all = words(name)
		const named = all.filter(nameWord)

		if (named.length === 0) {
			const short = all.filter(distinctive)
			const hits = short.filter(word => this.messageWords.includes(word)).length

			return short.length > 0 && hits >= Math.ceil(short.length / 2)
		}

		const hits = named.filter(word =>
			wordInMessage({
				word,
				message: this.message,
				messageWords: this.messageWords,
				strict: true
			})
		).length

		return hits >= Math.ceil(named.length / 2)
	}

	private argumentHandles({ tool, args }: { tool: AssistantTool; args: Record<string, unknown> }): string[] {
		return handleArguments(tool, args)
	}

	private argumentsGrounded({
		tool,
		args,
		lookup
	}: {
		tool: AssistantTool
		args: Record<string, unknown>
		// Grounding a lookup's results: its handles must not come from another lookup.
		lookup: boolean
	}): AssistantGuardDecision {
		const handles = this.argumentHandles({
			tool,
			args
		})

		for (const handle of handles) {
			if (!this.handleGrounded(handle, { lookups: !lookup })) {
				return {
					allowed: false,
					reason: `"${handle}" was not part of the user's request`
				}
			}
		}

		// A rename keeps its item's extension without the user repeating it.
		const currentName = handles.length === 1 && handles[0] !== undefined ? this.names.get(handles[0]) : undefined

		for (const key of tool.grounded.text ?? []) {
			const value = args[key]

			if (typeof value === "string" && !this.textGroundedStrictly(value, currentName)) {
				return {
					allowed: false,
					reason: `"${value}" does not come from the user's message`
				}
			}
		}

		return {
			allowed: true
		}
	}

	// The tools to offer for the next step.
	offered<T extends AssistantTool>(tools: readonly T[]): T[] {
		const tainted = this.options.taintGate && this.taintLevel === "content"

		return tools.filter(
			tool =>
				(this.options.consequentialAllowed && !tainted) || (!isConsequentialTool(tool) && !(tainted && tool.name === "open_route"))
		)
	}

	check({ tool, args }: { tool: AssistantTool; args: Record<string, unknown> }): AssistantGuardDecision {
		const consequential = isConsequentialTool(tool)
		const tainted = this.options.taintGate && this.taintLevel === "content"

		if (consequential && !this.options.consequentialAllowed) {
			return {
				allowed: false,
				reason: "The user's request does not ask for a change."
			}
		}

		if (tainted && (consequential || tool.name === "open_route")) {
			return {
				allowed: false,
				reason: "Not available after reading content from files, notes or chats in this request. Ask the user to request it directly."
			}
		}

		// A message or note the assistant writes is the user's own words to other people: a link in it that the
		// user did not type came from somewhere else (a planted name, a summary).
		for (const key of consequential && this.options.grounding ? (tool.grounded.links ?? []) : []) {
			const value = args[key]
			const foreign = typeof value === "string" ? foreignLinks({ text: value, userMessage: this.userMessage }) : []

			if (foreign.length > 0) {
				return {
					allowed: false,
					reason: "The text holds a link or address that does not come from the user's message"
				}
			}
		}

		if ((consequential && this.options.grounding) || (tainted && tool.effect === "navigate")) {
			return this.argumentsGrounded({
				tool,
				args,
				lookup: false
			})
		}

		return {
			allowed: true
		}
	}

	// Names a failed call offered instead of the handle it was given: no content was read, so nothing taints
	// and nothing is grounded.
	recordCandidates(
		candidates: readonly {
			handle: string
			name: string
		}[]
	): void {
		for (const { handle, name } of candidates) {
			this.names.set(handle, name)
		}
	}

	// Call after a tool ran. `returned` lists the handles its result exposed, with display names. `listed` is the
	// directory a listing showed the contents of.
	record({
		tool,
		args,
		returned,
		created = [],
		listed
	}: {
		tool: AssistantTool
		args: Record<string, unknown>
		returned: readonly {
			handle: string
			name: string
		}[]
		created?: readonly string[]
		listed?: string | undefined
	}): void {
		if (TAINT_ORDER.indexOf(tool.untrustedOutput) > TAINT_ORDER.indexOf(this.taintLevel)) {
			this.taintLevel = tool.untrustedOutput
		}

		for (const { handle, name } of returned) {
			// A handle shown without a name stands for itself: it does not replace the name an earlier result gave.
			if (name !== handle || !this.names.has(handle)) {
				this.names.set(handle, name)
			}
		}

		// A consequential call only got here grounded, so what it created is the user's too.
		for (const handle of created) {
			this.grounded.add(handle)
		}

		// The contents of a directory the user named or sees, whatever else the call said (a path beside the handle):
		// the directory itself must trace back to the user directly, so this grounds one level and never chains.
		if (tool.effect === "read" && listed !== undefined && this.handleGrounded(listed, { lookups: false })) {
			for (const { handle } of returned) {
				this.lookupGrounded.add(handle)
			}

			return
		}

		const handleKeyed = (tool.grounded.handles ?? []).some(key => args[key] !== undefined)
		const keyed =
			handleKeyed ||
			(tool.grounded.text ?? []).some(key => {
				const value = args[key]

				return typeof value === "string" ? selectiveWords(value).length > 0 : value !== undefined
			})

		if (
			tool.effect !== "read" ||
			!keyed ||
			!this.argumentsGrounded({
				tool,
				args,
				lookup: true
			}).allowed
		) {
			return
		}

		// A path names its directory exactly and grounds all it lists; a query matches names by their words.
		const query = args["query"]
		const queryWords = !handleKeyed && typeof query === "string" ? selectiveWords(query) : []
		const shortOnly = queryWords.length > 0 && typeof query === "string" && !hasNameWord(query)

		for (const { handle, name } of returned) {
			if (!shortOnly || nameHoldsWords({ name, queryWords })) {
				this.lookupGrounded.add(handle)
			}
		}
	}
}
