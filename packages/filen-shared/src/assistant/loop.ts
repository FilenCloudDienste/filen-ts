import { resultItemCount, toolCallSubject } from "./activity"
import { clipData, estimateTokens, MESSAGE_OVERHEAD_TOKENS, messageLines, serializeToolResult } from "./budget"
import { AssistantTurnGuard } from "./guard"
import { foreignTokens, replyHandles, replyWithHandles, replyWithoutHandles, settledReply } from "./handles"
import {
	ASSISTANT_CLOSING_NUDGE,
	ASSISTANT_MALFORMED_RETRY,
	assistantDateLine,
	assistantInstructionLines,
	assistantSystemPrompt,
	assistantUserPrompt,
	messageEdges,
	ROUTER_GRAMMAR,
	ROUTER_SYSTEM_PROMPT,
	routerRequest
} from "./prompts"
import {
	isConsequentialTool,
	parseToolInput,
	toolInputJsonSchema,
	type AssistantRoute,
	type AssistantTool,
	type AssistantToolEffect,
	type AssistantToolGroup,
	type PortableObjectSchema
} from "./tool"
import { ASSISTANT_TOOL_GROUPS, ASSISTANT_TOOLS, assistantToolByName } from "./tools"
import {
	type AssistantExtractionSource,
	extractionSource,
	mapUntrustedStrings,
	quarantinedExtractionPrompt,
	sanitizeUntrustedText,
	screenAssistantReply,
	type ScreenedReply,
	spotlightInstruction,
	spotlightText,
	type SpotlightMode,
	type SpotlightOptions
} from "./untrusted"

// The agent loop the eval (packages/filen-assistant-eval) validated, for any engine that renders the
// model's own chat template and constrains tool calls to their JSON schema (wllama, llama.rn):
//
// 1. The router reads only the user's own words (this message and the one before it, so the answer to a
//    clarifying question routes like the request it answers) and picks one tool group plus read or change,
//    under a grammar that admits nothing else.
// 2. Up to MAX_STEPS steps may call that group's tools, minus what the guard withdraws (guard.ts). Every
//    step renders the tools of the group's whole family (ASSISTANT_PROMPT_FAMILIES), the same for every
//    route in it, so the engine reuses the prompt when the route changes within a family; when that is more
//    than the request may call, the user's turn names what it may. A call outside them is refused here.
//    Every call is schema-validated, checked by the app (unknown handles, names where handles belong) and
//    by the guard; one malformed step is retried with the error, a second ends the loop. A lookup's first
//    step must call one of the tools that read.
// 3. Content other people wrote (note bodies, file text, chat messages) is summarized by a tool-less
//    quarantine call before the main loop sees it, and every untrusted string is sanitized and
//    spotlighted. The executor's context line carries other people's names too and is sanitized as well.
// 4. A consequential call runs only after the user confirmed it. A turn that ends without a text reply
//    gets one more generation, which may call no tool. The reply is screened before the user sees any of it.

// The part of AbortSignal the loop needs; the shared package compiles without DOM types, and a DOM or
// React Native AbortSignal satisfies it as is.
export interface AssistantSignal {
	readonly aborted: boolean
	addEventListener(type: "abort", listener: () => void, options?: { once?: boolean }): void
	removeEventListener(type: "abort", listener: () => void): void
}

export type AssistantModelToolCall = {
	id: string
	name: string
	// Raw JSON object text, as the engine parsed it out of the model's tool-call syntax.
	arguments: string
}

export type AssistantChatMessage =
	| {
			role: "system" | "user"
			content: string
	  }
	| {
			role: "assistant"
			content: string
			toolCalls?: readonly AssistantModelToolCall[]
	  }
	| {
			role: "tool"
			content: string
			toolCallId: string
	  }

export type AssistantModelTool = {
	name: string
	description: string
	parameters: PortableObjectSchema
}

export type AssistantGenerateRequest = {
	messages: readonly AssistantChatMessage[]
	tools?: readonly AssistantModelTool[]
	// GBNF; never combined with tools.
	grammar?: string
	// "none": the tools are rendered into the prompt as on the steps before, so the engine reuses what it read
	// of them, but no call is parsed or constrained. "required": the reply must be a call; text an engine lets
	// come before it is dropped unseen.
	toolChoice?: "none" | "required"
	// Which kind of request this is, for an engine that keeps one cached prompt per kind: each kind continues
	// its own, so none of them pushes another's out.
	slot: "router" | "main" | "extraction"
	maxTokens: number
}

export type AssistantGenerateResult = {
	content: string
	toolCalls: readonly AssistantModelToolCall[]
	// The generation stopped at maxTokens rather than ending on its own.
	truncated?: boolean
}

// How far the engine has read the prompt, in tokens, leaving out a prefix it reused from its cache.
export type AssistantPromptProgress = {
	processed: number
	total: number
}

export interface AssistantModel {
	readonly contextTokens: number
	// The loaded model's own special-token strings, for sanitizeUntrustedText.
	readonly specialTokens: readonly string[]
	// `onText` receives the whole text content generated so far, never a delta. `onProgress` reports the
	// prompt being read, before the first token; `onToolCall` reports a tool call as soon as its complete
	// name is known, by its position among the calls this generation returns, before its arguments are
	// decoded. Both are optional for an engine that cannot tell.
	generate(
		request: AssistantGenerateRequest,
		options: {
			signal: AssistantSignal
			onText?: (text: string) => void
			onProgress?: (progress: AssistantPromptProgress) => void
			onToolCall?: (call: { index: number; name: string }) => void
		}
	): Promise<AssistantGenerateResult>
}

export type AssistantToolCandidate = {
	handle: string
	name: string
}

export type AssistantToolOutcome =
	| {
			ok: true
			// What the model gets back; serialized as JSON.
			result: unknown
			// Every handle the result shows, with its name; derived from `handle` fields when absent.
			returned?: readonly AssistantToolCandidate[]
			// Handles of items a consequential call created.
			created?: readonly string[]
	  }
	| AssistantToolFailure

export type AssistantToolFailure = {
	ok: false
	// A malformed call (schema, unknown or wrong-kind handle) as opposed to a valid call the app refused;
	// the turn's single retry is spent on these.
	invalid: boolean
	error: string
	// The tool result for the model; { error, candidates } when absent.
	result?: unknown
	// Items whose names match a name the model passed where a handle belongs.
	candidates?: readonly AssistantToolCandidate[]
}

// A running call's own progress, for a call that can take a while (a search waiting for the drive's index):
// the `share` (0..1) of its work done and how many results it has `found` so far, each null when unknown.
export type AssistantToolProgress = {
	share: number | null
	found: number | null
}

// The app side of the loop. Implementations hand out short handles ("f3", "n2") and keep the mapping to
// real items for the session; the model never sees a UUID.
export interface AssistantToolExecutor {
	// What the user sees when the turn starts: one line for the system prompt, and the handles it names
	// (current directory, selection, playing track), which ground consequential calls.
	context(): Promise<{
		description: string
		handles: readonly string[]
	}>
	// Runs before the guard, as the eval did: resolves paths given where a handle belongs and rejects
	// handles the conversation never handed out, with candidates when a name was passed instead. A tool
	// the app cannot run yet fails here too (invalid: false). The returned args replace the model's.
	check(call: { callId: string; tool: AssistantTool; args: Record<string, unknown> }): Promise<
		| {
				ok: true
				args: Record<string, unknown>
		  }
		| AssistantToolFailure
	>
	// The name a handle this executor handed out stands for, to label a call in the UI.
	name?(handle: string): string | undefined
	// False for a tool this app cannot run (yet); it is never offered to the model. All tools when absent.
	supports?(tool: AssistantTool): boolean
	// `confirmed` is true only for a consequential call the user confirmed. `onProgress` may be called while
	// the call runs; calls after it settled are dropped.
	execute(call: {
		callId: string
		tool: AssistantTool
		args: Record<string, unknown>
		confirmed: boolean
		signal: AssistantSignal
		onProgress?: (progress: AssistantToolProgress) => void
	}): Promise<AssistantToolOutcome>
}

// "preparing": the model is still writing the call's arguments. "queued": written, waiting for the calls
// before it in the same step. "discarded": a call announced early that never reached the dispatcher; it did
// not run. "repeated": the same call already ran this request, so it was not run again.
export type AssistantToolCallStatus =
	"preparing" | "queued" | "running" | "confirming" | "ok" | "error" | "invalid" | "blocked" | "declined" | "discarded" | "repeated"

export type AssistantToolCallRecord = {
	id: string
	step: number
	tool: string
	title: string
	effect: AssistantToolEffect | null
	consequential: boolean
	args: Record<string, unknown>
	status: AssistantToolCallStatus
	error?: string
	// For the UI (activity.ts): what the checked call acts on, sanitized and shortened, when it names one
	// thing; and how many items a listing returned, `resultMore` when the list was cut off.
	subject?: string
	resultCount?: number
	resultMore?: boolean
}

export type AssistantConfirmationRequest = {
	callId: string
	tool: AssistantTool
	args: Record<string, unknown>
}

export type AssistantTurnPhase = "routing" | "thinking" | "tool" | "confirming" | "replying"

export type AssistantTurnEvent =
	| {
			type: "phase"
			phase: AssistantTurnPhase
	  }
	| {
			type: "route"
			route: AssistantRoute | null
			intent: "read" | "change" | null
	  }
	| {
			// The screened text of the reply being written; each event replaces the previous text until one
			// with `final`, after which the next reply text starts a new reply (text written before tool
			// calls stays as its own reply). `withheld`: the reply repeated the assistant's instructions, its
			// text is empty and the app shows its own message instead.
			type: "reply"
			text: string
			final: boolean
			withheld?: boolean
	  }
	| {
			type: "call"
			call: AssistantToolCallRecord
	  }
	| {
			// The prompt of the generation under way (routing, a step, a content extraction or the closing
			// reply) being read.
			type: "progress"
			progress: AssistantPromptProgress
	  }
	| {
			// The running call's own progress, as its executor reports it.
			type: "callProgress"
			callId: string
			progress: AssistantToolProgress
	  }

// A call an earlier turn made, as the model wrote it.
export type AssistantHistoryCall = {
	name: string
	arguments: string
}

export type AssistantHistoryTurn = {
	user: string
	reply: string
	// The user's turn as the model read it (assistantUserPrompt): given back unchanged, the conversation reads
	// the same on the next turn and the engine reuses it.
	prompt?: string
	// The navigation and changes that ran for this reply (historyCalls). Read back without the calls that did
	// them, replies that say something was opened or drafted teach the model to claim actions without calling,
	// and over a long conversation to answer new requests from earlier replies. Reads stay out: shown a read
	// whose result is gone, the model made up what it held (a link to pass on, the next page).
	calls?: readonly AssistantHistoryCall[]
}

// Prior exchanges kept for context, at most this many and about this many tokens: an exchange from long ago
// rarely matters to the next request.
const HISTORY_MAX = 12
const HISTORY_MAX_TOKENS = 1800

// What an earlier call's result reads as: the reply after it says what came of it.
const HISTORY_RESULT = serializeToolResult({ omitted: "Earlier result; call the tool again if it is still needed." })

function historyMessages(exchange: AssistantHistoryTurn, index: number): AssistantChatMessage[] {
	const calls = (exchange.calls ?? []).map((call, position) => ({ ...call, id: `history_${String(index)}_${String(position)}` }))

	return [
		{
			role: "user",
			content: exchange.prompt ?? exchange.user
		},
		...(calls.length === 0
			? []
			: [
					{
						role: "assistant" as const,
						content: "",
						toolCalls: calls
					},
					...calls.map(call => ({
						role: "tool" as const,
						toolCallId: call.id,
						content: HISTORY_RESULT
					}))
				]),
		{
			role: "assistant",
			content: exchange.reply
		}
	]
}

// The handles an earlier turn's calls took.
function callHandles(calls: readonly AssistantHistoryCall[] = []): string[] {
	return calls.flatMap(call => {
		const tool = assistantToolByName(call.name)
		const args = tool === undefined ? null : parseArguments(call.arguments)

		return tool === undefined || args === null
			? []
			: (tool.grounded.handles ?? []).flatMap(key => {
					const value = args[key]

					return typeof value === "string" ? [value] : Array.isArray(value) ? value.filter(item => typeof item === "string") : []
				})
	})
}

function exchangeTokens(exchange: AssistantHistoryTurn): number {
	return historyMessages(exchange, 0).reduce((sum, message) => sum + messageTokens(message), 0)
}

// The exchanges the next turns read, after one was added; the apps' sessions and the eval keep a conversation
// through this. Within the budget they only ever grow, so each turn's prompt continues the last one and the
// engine reads just the new exchange: it reuses a cached prompt only up to the first difference, and dropping
// the oldest exchange would put that difference at the start. Over the budget they are cut at once to the
// newest that fit half of it (always the last), so a full re-read comes every few turns instead of on each.
export function windowHistory(history: readonly AssistantHistoryTurn[]): AssistantHistoryTurn[] {
	const total = history.reduce((sum, exchange) => sum + exchangeTokens(exchange), 0)

	if (history.length <= HISTORY_MAX && total <= HISTORY_MAX_TOKENS) {
		return history.slice()
	}

	const kept: AssistantHistoryTurn[] = []
	let tokens = 0

	for (let index = history.length - 1; index >= 0 && kept.length < HISTORY_MAX / 2; index--) {
		const exchange = history[index]

		if (exchange === undefined) {
			break
		}

		tokens += exchangeTokens(exchange)

		if (kept.length > 0 && tokens > HISTORY_MAX_TOKENS / 2) {
			break
		}

		kept.unshift(exchange)
	}

	return kept
}

export type AssistantTurnResult = {
	reply: string
	// The reply as later turns read it, for AssistantHistoryTurn.reply: with the handles of the items it names,
	// which the shown reply leaves out.
	historyReply: string
	// For AssistantHistoryTurn.calls.
	historyCalls: AssistantHistoryCall[]
	// The user's turn as the model read it, for AssistantHistoryTurn.prompt.
	prompt: string
	withheld: boolean
	route: AssistantRoute | null
	intent: "read" | "change" | null
	calls: AssistantToolCallRecord[]
	unrecovered: boolean
	stepCapHit: boolean
}

export class AssistantAbortError extends Error {
	override readonly name = "AbortError"

	constructor() {
		super("The assistant turn was cancelled")
	}
}

export class AssistantContextError extends Error {
	constructor() {
		super("The message does not fit the model's context")
	}
}

// The user's message alone is too long for a first step, whatever the conversation holds.
export class AssistantMessageTooLongError extends AssistantContextError {}

export const MAX_STEPS = 5
export const STEP_MAX_TOKENS = 384
// The most a step that writes the user's own text may generate.
export const STEP_TEXT_MAX_TOKENS = 1536
export const QUARANTINE_MAX_TOKENS = 200
const ROUTER_MAX_TOKENS = 8

// Routes whose read requests mostly act (play, pause, open a screen): a call forced there is an action the
// user may not have asked for ("Thanks!" after a song skipped the next one).
const ACTING_ROUTES: ReadonlySet<AssistantRoute> = new Set(["audio", "navigation"])

// What the router and the content extraction may fill of an engine's context besides the main loop's
// `contextTokens`. An engine that keeps the three in one cache sizes it to the sum: when they overflow it,
// the engine clears idle slots, and the router's cached system prompt goes first.
export const ROUTER_CONTEXT_TOKENS = 2048
export const QUARANTINE_CONTEXT_TOKENS = 2048

// Tool-call syntax a model wrote as text instead of as a call: template markup, or a call to one of the
// tools it was offered. Only those tool names count, so everyday code in a reply ("df.sort_values(by=…)")
// is not mistaken for a call.
const CALL_MARKUP = /<tool_call>|<\|tool_call_start\|>|<function=|\|\|call:/

function callPattern(toolNames: readonly string[]): RegExp {
	if (toolNames.length === 0) {
		return CALL_MARKUP
	}

	const names = toolNames.join("|")

	return new RegExp(
		`${CALL_MARKUP.source}|"name"\\s*:\\s*"(?:${names})"\\s*,\\s*"(?:arguments|parameters)"|(?<![\\w.])(?:${names})\\s*\\(`
	)
}

// The call syntax in a reply that may not call tools: removed, the text around it kept.
function stripCallSyntax(text: string, toolNames: readonly string[]): string {
	const names = toolNames.join("|")
	let stripped = text
		.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|$)/g, "")
		.replace(/<function=[\s\S]*?(?:<\/function>|$)/g, "")
		.replace(/<\|tool_call_start\|>[\s\S]*?(?:<\|tool_call_end\|>|$)/g, "")
		.replace(/\|\|call:[^\n]*/g, "")

	if (names.length > 0) {
		stripped = stripped
			.replace(new RegExp(`\\{[^{}]*"name"\\s*:\\s*"(?:${names})"[^\\n]*`, "g"), "")
			.replace(new RegExp(`(?<![\\w.])(?:${names})\\s*\\([^\\n]*`, "g"), "")
	}

	return stripped.trim()
}

const CONTENT_FIELDS = ["content", "messages"]

const STUB_TEXT = "Result dropped to fit the context; call the tool again if it is still needed."

const CUT_CALL = "The call was cut off at the length limit; use a shorter text."

// The user's own earlier messages the router and the guard read along with this one, so the answer to a
// clarifying question ("Schmidt", "yes, the second one") is routed and grounded like the request it answers.
// Only text the user typed: assistant replies never ground anything.
const PRIOR_USER_MESSAGES = 2

// A reply to a clarifying question ("Tom Lee", "yes", "第一个") is a few words. Only such a message gets the
// previous one beside it in a content extraction: beside a request of its own, the previous message got
// answered too, or set the extraction's language.
const CLARIFICATION_MAX_CHARS = 20

function answersEarlier(message: string): boolean {
	return Array.from(message.trim()).length <= CLARIFICATION_MAX_CHARS
}

// A follow-up this short ("yes", "the second one", "Lies die zweite", "2番目を読んで") rarely names what it is
// about: it is routed beside the user's previous message. A longer one says what it wants, and beside a
// previous request that shares a word with it ("my offsite note", then "my offsite chat") it is pulled to
// that request's route, so it is routed on its own. Wide (CJK) characters count twice: they say about as
// much as two Latin ones.
const FOLLOW_UP_MAX_WIDTH = 30
const WIDE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\uff01-\uff60]/u

function routesBesideEarlier(message: string): boolean {
	let width = 0

	for (const char of message.trim()) {
		width += WIDE.test(char) ? 2 : 1

		if (width > FOLLOW_UP_MAX_WIDTH) {
			return false
		}
	}

	return true
}

const SPOTLIGHT_DELIMITER = /[⟦⟧]/g

// A reply that stopped at the length limit reads as cut off rather than as finished mid-word.
function markCut(text: string): string {
	return `${text.trimEnd()}…`
}

type GenerateOptions = Parameters<AssistantModel["generate"]>[1]

// An engine may deliver a callback after its generation settled (a worker's updates and its result travel
// on different ports): by then the result supersedes it, so it is dropped rather than reopening a row or a
// reply that already ended.
async function generateSettled(
	model: AssistantModel,
	request: AssistantGenerateRequest,
	{ signal, onText, onProgress, onToolCall }: GenerateOptions
): Promise<AssistantGenerateResult> {
	let settled = false
	const live =
		<T>(callback: ((value: T) => void) | undefined) =>
		(value: T) => {
			if (!settled) {
				callback?.(value)
			}
		}

	try {
		return await model.generate(request, {
			signal,
			...(onText === undefined ? {} : { onText: live(onText) }),
			...(onProgress === undefined ? {} : { onProgress: live(onProgress) }),
			...(onToolCall === undefined ? {} : { onToolCall: live(onToolCall) })
		})
	} finally {
		settled = true
	}
}

function checkAborted(signal: AssistantSignal): void {
	if (signal.aborted) {
		throw new AssistantAbortError()
	}
}

export function parseRoute(raw: string): { route: AssistantRoute | null; intent: "read" | "change" | null } {
	const [routeWord, intentWord] = raw.trim().split(" ")
	const route =
		routeWord === "answer"
			? "answer"
			: routeWord !== undefined && Object.hasOwn(ASSISTANT_TOOL_GROUPS, routeWord)
				? (routeWord as AssistantToolGroup)
				: null

	return {
		route,
		intent: intentWord === "read" || intentWord === "change" ? intentWord : null
	}
}

// Every handle a tool result exposes, with the name or title next to it.
function handlesIn(value: unknown, found = new Map<string, string>()): Map<string, string> {
	if (Array.isArray(value)) {
		for (const item of value) {
			handlesIn(item, found)
		}
	} else if (typeof value === "object" && value !== null) {
		const record = value as Record<string, unknown>
		const handle = record["handle"]
		const name = record["name"] ?? record["title"]

		if (typeof handle === "string") {
			found.set(handle, typeof name === "string" ? name : handle)
		}

		for (const entry of Object.values(record)) {
			handlesIn(entry, found)
		}
	}

	return found
}

function failureResult(failure: AssistantToolFailure): unknown {
	return (
		failure.result ?? {
			error: failure.error,
			...(failure.candidates === undefined
				? {}
				: {
						candidates: failure.candidates
					})
		}
	)
}

function normalizeForEcho(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ")
}

const ECHO_FRAGMENT = 40

// Withholds a reply that repeats the canary or any instruction line (from its first words on), and
// defangs links the user did not type. Runs on partial replies too, so nothing unscreened is shown.
export function screenReply({
	reply,
	userMessage,
	canary,
	instructions
}: {
	reply: string
	userMessage: string
	canary: string
	instructions: readonly string[]
}): ScreenedReply {
	const normalized = normalizeForEcho(reply)
	const echoes = instructions.some(line => {
		const fragment = normalizeForEcho(line.replace(/^- /, "")).slice(0, ECHO_FRAGMENT)

		return fragment.length === ECHO_FRAGMENT && normalized.includes(fragment)
	})

	return screenAssistantReply({
		// An echo is withheld exactly like a canary hit.
		reply: echoes ? canary : reply,
		userMessage,
		canary
	})
}

function messageTokens(message: AssistantChatMessage): number {
	const calls = message.role === "assistant" ? (message.toolCalls ?? []).map(call => call.name + call.arguments).join("") : ""

	return estimateTokens(message.content + calls) + MESSAGE_OVERHEAD_TOKENS
}

// Keeps the prompt inside the context: older conversation turns go first, then the oldest tool results
// of this turn are replaced by a stub. The system prompt and the user's message always stay. Once any
// history goes, the turn's first message becomes `fullPrompt` (the date and screen context it left out as
// said by the earlier turns), since those turns may be the ones dropped.
export function fitMessages({
	system,
	history,
	turn,
	tools,
	maxTokens,
	contextTokens,
	fullPrompt,
	onStub
}: {
	system: AssistantChatMessage
	history: readonly AssistantChatMessage[]
	turn: readonly AssistantChatMessage[]
	tools: readonly AssistantModelTool[]
	maxTokens: number
	contextTokens: number
	fullPrompt?: string
	// Told which tool results were replaced by the stub, so the call may run again.
	onStub?: (toolCallId: string) => void
}): AssistantChatMessage[] {
	const budget = contextTokens - maxTokens - estimateTokens(JSON.stringify(tools)) - messageTokens(system)
	let kept = history.slice()
	const current = turn.slice()
	const total = () => [...kept, ...current].reduce((sum, message) => sum + messageTokens(message), 0)
	const first = current[0]

	while (total() > budget && kept.length > 0) {
		// Whole exchanges go, each from its user message to the next.
		const next = kept.findIndex((message, index) => index > 0 && message.role === "user")

		kept = next === -1 ? [] : kept.slice(next)

		if (fullPrompt !== undefined && first?.role === "user") {
			current[0] = { ...first, content: fullPrompt }
		}
	}

	for (let index = 0; index < current.length && total() > budget; index++) {
		const message = current[index]

		if (message?.role === "tool") {
			onStub?.(message.toolCallId)
			current[index] = {
				...message,
				content: JSON.stringify({
					omitted: STUB_TEXT
				})
			}
		}
	}

	if (total() > budget) {
		throw new AssistantContextError()
	}

	return [system, ...kept, ...current]
}

// A consequential tool that writes free text the user dictates, which reaches other people (a draft).
function writesText(tool: AssistantTool): boolean {
	return isConsequentialTool(tool) && (tool.grounded.links ?? []).length > 0
}

function toModelTools(tools: readonly AssistantTool[]): AssistantModelTool[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: toolInputJsonSchema(tool)
	}))
}

// Routes whose requests render the same tools, so a route change within one reuses the prompt the engine
// read: the chat template puts the tools first, and a hybrid model resumes a cached prompt only from a stored
// state, which a prompt differing in its first lines leaves none of. Each family stays near the size of its
// largest group, so a conversation that keeps to one group pays little for the others, and its groups take
// the same form of every tool they share (insights, which searches and lists by date, is a family of its
// own). Organize stays alone: shown the drive family, its refusals of writes an app does not run drifted
// out of the user's language. The answer route renders no tools: shown tools it may not call, the model
// tries them anyway.
export const ASSISTANT_PROMPT_FAMILIES: readonly (readonly AssistantToolGroup[])[] = [
	["files", "trash", "shared"],
	["organize"],
	["insights"],
	["notes", "chats"],
	["audio", "navigation"]
]

// Every tool of a route's family, supported or not, in the family's order: its first group's as that group
// alone lists them, then each later group's new ones; none for the answer route.
function familyTools(route: AssistantRoute | null): AssistantTool[] {
	const family = route === null || route === "answer" ? [] : (ASSISTANT_PROMPT_FAMILIES.find(groups => groups.includes(route)) ?? [route])

	return [...new Map(family.flatMap(group => ASSISTANT_TOOL_GROUPS[group].tools).map(tool => [tool.name, tool])).values()]
}

// The tokens every main step needs besides the user's message: the instructions with the longest spotlight
// line and the family's unavailable-tools line, room for the context, date and tools lines, the largest
// family's tool schemas and the reply.
const CONTEXT_RESERVE_TOKENS = 400

// By the tools the app cannot run, which an executor never changes.
const fixedStepTokensCache = new Map<string, number>()

function fixedStepTokens(supports: (tool: AssistantTool) => boolean): number {
	const key = ASSISTANT_TOOLS.filter(tool => !supports(tool))
		.map(tool => tool.name)
		.join(",")
	const cached = fixedStepTokensCache.get(key)

	if (cached !== undefined) {
		return cached
	}

	const tokens =
		Math.max(
			...ASSISTANT_PROMPT_FAMILIES.map(groups => {
				const family = familyTools(groups[0] ?? null)
				const unavailable = family.filter(tool => !supports(tool)).map(tool => tool.title)

				return (
					Math.max(
						...[true, false].map(canTrash =>
							estimateTokens(
								assistantSystemPrompt({
									spotlight: spotlightInstruction({ mode: "delimit" }),
									canary: "x".repeat(32),
									unavailable,
									canTrash
								})
							)
						)
					) + estimateTokens(JSON.stringify(toModelTools(family.filter(supports))))
				)
			})
		) +
		CONTEXT_RESERVE_TOKENS +
		STEP_MAX_TOKENS +
		MESSAGE_OVERHEAD_TOKENS * 2

	fixedStepTokensCache.set(key, tokens)

	return tokens
}

// A message that cannot fit even a first step is refused before the router reads it. `supports` as the
// executor's: a step renders the tools the app runs of the route's whole family.
export function messageFitsContext(
	message: string,
	contextTokens: number,
	supports: (tool: AssistantTool) => boolean = () => true
): boolean {
	return estimateTokens(message) + MESSAGE_OVERHEAD_TOKENS <= contextTokens - fixedStepTokens(supports)
}

function parseArguments(raw: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(raw.trim() === "" ? "{}" : raw)

		return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null
	} catch {
		return null
	}
}

export async function runAssistantTurn({
	model,
	executor,
	history,
	message,
	signal,
	onEvent,
	confirm,
	nonce,
	secrets,
	now,
	timeZone,
	weekStart,
	spotlight = "delimit"
}: {
	model: AssistantModel
	executor: AssistantToolExecutor
	// Earlier exchanges of this conversation; `user` is the user's own text.
	history: readonly AssistantHistoryTurn[]
	message: string
	signal: AssistantSignal
	onEvent: (event: AssistantTurnEvent) => void
	// Resolves true only when the user confirmed this exact call.
	confirm: (request: AssistantConfirmationRequest, signal: AssistantSignal) => Promise<boolean>
	// Unpredictable to other people's text: the canary, unless `secrets` are given.
	nonce: () => string
	// The conversation's own canary: the same on every turn, so the system prompt does not change between
	// turns and the engine can reuse what it already read.
	secrets?: {
		canary: string
	}
	// The user's clock, time zone (IANA) and first weekday (1 Monday to 7 Sunday), for a "Today" line: tool
	// results carry dates.
	now?: number
	timeZone?: string
	weekStart?: number
	spotlight?: SpotlightMode | "off"
}): Promise<AssistantTurnResult> {
	checkAborted(signal)

	const supports = (tool: AssistantTool) => executor.supports?.(tool) ?? true

	if (!messageFitsContext(message, model.contextTokens, supports)) {
		throw new AssistantMessageTooLongError()
	}

	const priorUser = history
		.slice(-PRIOR_USER_MESSAGES)
		.map(entry => entry.user)
		.filter(text => text.trim().length > 0)
	const userText = [...priorUser, message].join("\n")

	onEvent({
		type: "phase",
		phase: "routing"
	})

	const onProgress = (progress: AssistantPromptProgress) => {
		onEvent({
			type: "progress",
			progress
		})
	}
	const routeBy = (earlier: string | undefined) =>
		generateSettled(
			model,
			{
				messages: [
					{
						role: "system",
						content: ROUTER_SYSTEM_PROMPT
					},
					{
						role: "user",
						content: routerRequest({
							message,
							earlier
						})
					}
				],
				grammar: ROUTER_GRAMMAR,
				slot: "router",
				maxTokens: ROUTER_MAX_TOKENS
			},
			{
				signal,
				onProgress
			}
		)
	const previous = priorUser.at(-1)
	// Routed beside the previous message: it continues that request, or only answers or thanks.
	let beside = previous !== undefined && routesBesideEarlier(message)
	let routed = await routeBy(beside ? previous : undefined)

	// A longer follow-up that on its own needs no tools may still continue the previous request ("That I paid
	// the Hetzner invoice", answering "What should it say?"): it is routed again beside it.
	if (previous !== undefined && !beside && parseRoute(routed.content).route === "answer") {
		checkAborted(signal)

		beside = true
		routed = await routeBy(previous)
	}

	const { route, intent } = parseRoute(routed.content)

	onEvent({
		type: "route",
		route,
		intent
	})
	checkAborted(signal)

	const context = await executor.context()
	// The context line names items, notes, chats and tracks other people may have named; it is sanitized like
	// any tool result and kept on one line.
	const contextLine = sanitizeUntrustedText(context.description, model.specialTokens, { keepJoiners: true }).replace(/\s+/g, " ").trim()
	const canary = secrets?.canary ?? nonce()
	const spotlightOptions: SpotlightOptions | null = spotlight === "off" ? null : { mode: spotlight }
	const instructionSpotlight = spotlightOptions === null ? null : spotlightInstruction(spotlightOptions)
	const trashTool = assistantToolByName("trash_items")
	const canTrash = trashTool !== undefined && supports(trashTool)
	const instructions = assistantInstructionLines(instructionSpotlight, { canTrash })
	const guard = new AssistantTurnGuard({
		options: {
			consequentialAllowed: intent === "change",
			grounding: true,
			taintGate: true
		},
		userMessage: userText,
		contextHandles: context.handles
	})

	// Items earlier replies show by handle, or earlier calls took, can be named again without a new lookup; like
	// a lookup's results, they ground a change only by the item's own name in the user's words.
	const historyHandles = [...new Set(history.flatMap(entry => [...replyHandles(entry.reply), ...callHandles(entry.calls)]))]

	guard.recordCandidates(
		historyHandles.flatMap(handle => {
			const name = executor.name?.(handle)

			return name === undefined ? [] : [{ handle, name }]
		})
	)
	const family = familyTools(route)
	const rendered = family.filter(supports)
	// The same for every route of the family (and so the same prompt prefix), never narrowed per turn: what
	// this turn may call is decided below and by the guard.
	const tools = toModelTools(rendered)
	const renderedNames = rendered.map(tool => tool.name)
	const groupTools = route === null || route === "answer" ? [] : ASSISTANT_TOOL_GROUPS[route].tools.filter(supports)
	// What this request may call at its start; only a request that renders more is told which.
	const callable = guard.offered(groupTools)
	// A request that looks something up: a change may need to ask for a missing detail instead of calling, and
	// a follow-up routed beside the previous message ("ok thanks", "the second one") takes its route from it.
	const lookup = intent === "read" && route !== null && route !== "answer" && !ACTING_ROUTES.has(route) && !beside
	// Any tool the model was shown: a call to one written as text is a call, not a reply.
	const malformed = callPattern(renderedNames)
	const system: AssistantChatMessage = {
		role: "system",
		content: assistantSystemPrompt({
			spotlight: instructionSpotlight,
			canary,
			unavailable: family.filter(tool => !supports(tool)).map(tool => tool.title),
			canTrash
		})
	}
	const promptParts = {
		message,
		context: contextLine,
		date: now === undefined ? null : assistantDateLine({ now, timeZone, weekStart }),
		tools: callable.length === rendered.length ? null : callable.map(tool => tool.name)
	}
	const prompt = assistantUserPrompt({
		...promptParts,
		earlier: history.flatMap(entry => (entry.prompt === undefined ? [] : [entry.prompt]))
	})
	// What the step reads once fitMessages drops the history that said the date and context already.
	const fullPrompt = assistantUserPrompt({ ...promptParts, earlier: [] })
	// A call that writes the user's text (a draft) may take as long as that text: dictated, it must arrive
	// whole, not shortened to fit. Only within what the context leaves; decoding costs nothing more unless
	// the model writes it.
	const stepTokens = callable.some(writesText)
		? STEP_MAX_TOKENS +
			Math.max(
				0,
				Math.min(
					STEP_TEXT_MAX_TOKENS - STEP_MAX_TOKENS,
					estimateTokens(message),
					model.contextTokens - fixedStepTokens(supports) - estimateTokens(message) - MESSAGE_OVERHEAD_TOKENS
				)
			)
		: STEP_MAX_TOKENS
	const past: AssistantChatMessage[] = history.flatMap(historyMessages)
	const turn: AssistantChatMessage[] = [
		{
			role: "user",
			content: prompt
		}
	]
	const calls: AssistantToolCallRecord[] = []
	const ran: AssistantHistoryCall[] = []
	const specialTokens = model.specialTokens
	const nameOf = (handle: string) => executor.name?.(handle)
	// Items this turn's results handed out, by handle: the next turns read their handles beside the names the
	// reply repeats.
	const handedOut = new Map<string, string>()
	const handOut = (items: readonly AssistantToolCandidate[]) => {
		for (const { handle, name } of items) {
			handedOut.set(handle, name)
		}
	}
	// The handles the model saw: in the context, earlier replies and this turn's results. A reply's other
	// tokens that look like one are left as written.
	const seen = new Set([...context.handles, ...historyHandles])
	// Tokens like a handle that the user typed or content read this turn holds ("room c12", "p1: fix login").
	const foreign = new Set(replyHandles(userText))
	const shownName = (handle: string) => {
		const name = seen.has(handle) || handedOut.has(handle) ? (nameOf(handle) ?? handedOut.get(handle)) : undefined

		return name === undefined ? undefined : sanitizeUntrustedText(name, specialTokens, { keepJoiners: true })
	}
	// A token no result or earlier reply gave out, of a kind they did ("f7" beside a listing's f9): one the
	// model made up, which names nothing.
	const invented = (handle: string) =>
		!seen.has(handle) && !handedOut.has(handle) && [...seen, ...handedOut.keys()].some(known => known.charAt(0) === handle.charAt(0))
	const screen = (reply: string, { handles = false }: { handles?: boolean } = {}) => {
		// The model copies spotlight delimiters it saw around item names into its reply.
		const text = reply.replace(SPOTLIGHT_DELIMITER, "")

		return screenReply({
			reply: handles ? text : replyWithoutHandles(text, shownName, { foreign, invented }),
			userMessage: userText,
			canary,
			instructions
		})
	}
	const replyEvent = (text: string, final: boolean): AssistantTurnEvent => {
		const screened = screen(final ? text : settledReply(text))

		return {
			type: "reply",
			text: screened.text,
			final,
			...(screened.withheld
				? {
						withheld: true
					}
				: {})
		}
	}
	// Joiners stay: without them Persian or Indic content reads, and is summarized, misspelled.
	const sanitized = (value: unknown) => {
		foreignTokens(value, foreign)

		return mapUntrustedStrings(value, text => sanitizeUntrustedText(text, specialTokens, { keepJoiners: true }))
	}
	const untrusted = (value: unknown) =>
		spotlightOptions === null ? sanitized(value) : mapUntrustedStrings(sanitized(value), text => spotlightText(text, spotlightOptions))
	// Streams the reply as it is written, screened, unless it turns out to be tool-call syntax.
	const streamReply = (text: string) => {
		if (!malformed.test(text)) {
			onEvent(replyEvent(text.trim(), false))
		}
	}
	const update = (record: AssistantToolCallRecord, patch: Partial<AssistantToolCallRecord>): AssistantToolCallRecord => {
		const next = {
			...record,
			...patch
		}

		calls[calls.indexOf(record)] = next
		onEvent({
			type: "call",
			call: next
		})

		return next
	}

	// Calls that ran this turn, by tool and arguments: a small model can loop on one lookup until the step cap.
	const executedCalls = new Set<string>()
	// Which call ran with which signature, so a result fitMessages had to drop can be fetched again.
	const signatures = new Map<string, string>()
	const forgetStubbed = (toolCallId: string) => {
		const signature = signatures.get(toolCallId)

		if (signature !== undefined) {
			executedCalls.delete(signature)
		}
	}
	let answer = ""
	// A step that could call nothing wrote nothing but a call.
	let callOnly = false
	let retryUsed = false
	let blockedSteps = 0
	let unrecovered = false
	let stepCapHit = false
	let declined = false

	for (let step = 1; step <= MAX_STEPS; step++) {
		checkAborted(signal)
		onEvent({
			type: "phase",
			phase: "thinking"
		})

		const offered = guard.offered(groupTools)
		// Calls the engine named while the model was still writing their arguments, by position. Only the
		// newest is being written; those before it wait to be dispatched.
		const announced = new Map<number, AssistantToolCallRecord>()
		const queueAnnounced = (except: string | null) => {
			for (const [index, record] of announced) {
				if (record.status === "preparing" && record.id !== except) {
					const queued: AssistantToolCallRecord = {
						...record,
						status: "queued"
					}

					announced.set(index, queued)
					onEvent({
						type: "call",
						call: queued
					})
				}
			}
		}
		const announce = ({ index, name }: { index: number; name: string }) => {
			const tool = offered.find(candidate => candidate.name === name)

			if (tool === undefined || announced.has(index)) {
				return
			}

			queueAnnounced(null)

			const record: AssistantToolCallRecord = {
				id: `call_${step}_${index}`,
				step,
				tool: tool.name,
				title: tool.title,
				effect: tool.effect,
				consequential: isConsequentialTool(tool),
				args: {},
				status: "preparing"
			}

			announced.set(index, record)
			onEvent({
				type: "call",
				call: record
			})
		}
		// An announced call that never reached the dispatcher (malformed, or cut off by a declined call
		// before it) did not run.
		const discardUnfinished = (finished: ReadonlySet<string>) => {
			for (const record of announced.values()) {
				if (!finished.has(record.id)) {
					onEvent({
						type: "call",
						call: {
							...record,
							status: "discarded"
						}
					})
				}
			}
		}
		// A lookup's first step must call a tool that reads: over a long conversation the model came to answer
		// new lookups from its earlier replies, making up what a call would have read. The engine enforces a call
		// and the guard still judges it; text written before it is dropped unseen, as it was written without the
		// result.
		const lookups = step === 1 && lookup ? offered.filter(tool => tool.effect === "read") : []
		const generate = (forced: boolean) =>
			generateSettled(
				model,
				{
					messages: fitMessages({
						system,
						history: past,
						turn,
						tools,
						maxTokens: stepTokens,
						contextTokens: model.contextTokens,
						...(fullPrompt === prompt ? {} : { fullPrompt }),
						onStub: forgetStubbed
					}),
					...(tools.length > 0
						? {
								tools,
								...(offered.length === 0 ? { toolChoice: "none" as const } : forced ? { toolChoice: "required" as const } : {})
							}
						: {}),
					slot: "main",
					maxTokens: stepTokens
				},
				{
					signal,
					...(forced ? {} : { onText: streamReply }),
					onProgress,
					// A forced call that is no lookup is written again: it never shows.
					onToolCall: forced
						? call => {
								if (lookups.some(tool => tool.name === call.name)) {
									announce(call)
								}
							}
						: announce
				}
			)
		let forced = lookups.length > 0
		let generated = await generate(forced)
		// Anything but reads (an engine that could not force a call, or the model opening or acting) makes it no
		// lookup: the step is written again unforced, and the request decides between acting and replying.
		const looksUp = generated.toolCalls.length > 0 && generated.toolCalls.every(call => lookups.some(tool => tool.name === call.name))

		if (forced && !looksUp) {
			discardUnfinished(new Set())
			announced.clear()
			forced = false
			generated = await generate(false)
		}

		const preamble = forced ? "" : generated.content.trim()

		if (generated.toolCalls.length === 0) {
			discardUnfinished(new Set())

			let text = generated.content.trim()

			if (offered.length === 0) {
				// Nothing could be called, so this is the reply: call syntax goes, the text around it stays. The same
				// request again would get the same output back, so a reply with nothing left goes to the closing
				// reply, which asks for plain text.
				text = stripCallSyntax(text, renderedNames)

				if (text.length === 0) {
					callOnly = true

					break
				}
			} else if (text.length === 0) {
				// Nothing at all: the same request again gets the same nothing back, so the closing reply asks for text.
				callOnly = true

				break
			} else if (malformed.test(text)) {
				if (!retryUsed && step < MAX_STEPS) {
					retryUsed = true
					turn.push(
						{
							role: "assistant",
							content: text
						},
						{
							role: "user",
							content: ASSISTANT_MALFORMED_RETRY
						}
					)

					continue
				}

				unrecovered = true

				break
			}

			answer = generated.truncated === true && text.length > 0 ? markCut(text) : text

			break
		}

		// The first call is dispatched next; the rest wait their turn.
		queueAnnounced(`call_${step}_0`)

		// Text written before the calls ("Let me look that up") stays as a reply of its own.
		if (preamble.length > 0) {
			onEvent(replyEvent(preamble, true))
		}

		const stepCalls = generated.toolCalls.map((call, index) => ({
			...call,
			id: `call_${step}_${index}`
		}))
		const results: AssistantChatMessage[] = []
		const processed: AssistantModelToolCall[] = []
		let invalidThisStep = false
		let blockedThisStep = 0

		for (const call of stepCalls) {
			checkAborted(signal)

			// Only the routed group's tools exist for this turn, whatever the model saw or the engine let through;
			// the guard refuses those it withdrew.
			const tool = groupTools.find(candidate => candidate.name === call.name)
			const raw = parseArguments(call.arguments)

			const shown = tool === undefined ? rendered.find(candidate => candidate.name === call.name) : undefined

			if (shown !== undefined) {
				// Shown, but not this request's to call: refused like a guard refusal, so it does not spend the
				// retry a malformed call needs, and kept off the step list, which would show an action the user
				// never asked for.
				const offeredNames = guard.offered(groupTools).map(candidate => candidate.name)
				const reason =
					offeredNames.length === 0
						? "No tools are available for this request; reply in plain text."
						: `Not available for this request; use ${offeredNames.join(", ")}.`

				blockedThisStep++
				calls.push({
					id: call.id,
					step,
					tool: shown.name,
					title: shown.title,
					effect: shown.effect,
					consequential: isConsequentialTool(shown),
					args: raw ?? {},
					status: "blocked",
					error: reason
				})
				processed.push(call)
				results.push({
					role: "tool",
					toolCallId: call.id,
					content: serializeToolResult({
						error: `Blocked: ${reason}`
					})
				})

				continue
			}

			let record: AssistantToolCallRecord = {
				id: call.id,
				step,
				tool: call.name,
				title: tool?.title ?? call.name,
				effect: tool?.effect ?? null,
				consequential: tool === undefined ? false : isConsequentialTool(tool),
				args: raw ?? {},
				status: "running"
			}
			let result: unknown

			calls.push(record)
			onEvent({
				type: "call",
				call: record
			})

			const parsed = tool === undefined || raw === null ? null : parseToolInput(tool, raw)

			if (tool === undefined || parsed === null || !parsed.ok) {
				const error =
					tool === undefined
						? `Tool "${call.name}" is not available for this request`
						: parsed === null || parsed.ok
							? generated.truncated === true
								? CUT_CALL
								: "Arguments are not a JSON object"
							: parsed.error

				record = update(record, {
					status: "invalid",
					error
				})
				result = {
					error: `Invalid call: ${error}`
				}
			} else {
				const checked = await executor.check({
					callId: call.id,
					tool,
					args: parsed.args
				})

				if (!checked.ok) {
					record = update(record, {
						status: checked.invalid ? "invalid" : "error",
						error: checked.error
					})
					result = failureResult(checked)

					// Only names came back: nothing was read, so the turn is not tainted.
					if (checked.candidates !== undefined) {
						guard.recordCandidates(checked.candidates)
						handOut(checked.candidates)
					}
				} else {
					const args = checked.args
					const decision = guard.check({
						tool,
						args
					})

					// A refused call shows no subject: what the guard did not let through is not repeated to the user.
					const subject = decision.allowed
						? toolCallSubject({
								tool,
								args,
								name: nameOf,
								grounded: text => guard.textGrounded(text),
								userMessage: message,
								canary,
								specialTokens
							})
						: undefined

					record = update(record, {
						args,
						...(subject === undefined
							? {}
							: {
									subject
								})
					})

					const signature = `${tool.name}:${JSON.stringify(args)}`
					const repeated = executedCalls.has(signature)

					if (!decision.allowed || repeated) {
						const reason = repeated
							? "Already called with these arguments in this request; use that result."
							: decision.allowed
								? ""
								: decision.reason

						blockedThisStep++
						record = update(record, {
							status: repeated ? "repeated" : "blocked",
							error: reason
						})
						result = {
							error: `Blocked: ${reason}`
						}
					} else {
						executedCalls.add(signature)
						signatures.set(call.id, signature)

						let approved = true

						if (isConsequentialTool(tool)) {
							record = update(record, {
								status: "confirming"
							})
							onEvent({
								type: "phase",
								phase: "confirming"
							})
							approved = await confirm(
								{
									callId: record.id,
									tool,
									args
								},
								signal
							)
							checkAborted(signal)
						}

						if (!approved) {
							declined = true
							record = update(record, {
								status: "declined"
							})
							result = {
								error: "The user declined this action."
							}
						} else {
							if (record.status === "confirming") {
								record = update(record, {
									status: "running"
								})
							}

							onEvent({
								type: "phase",
								phase: "tool"
							})

							const callId = record.id
							let running = true
							const outcome = await executor
								.execute({
									callId,
									tool,
									args,
									confirmed: isConsequentialTool(tool),
									signal,
									onProgress: progress => {
										if (running && !signal.aborted) {
											onEvent({
												type: "callProgress",
												callId,
												progress
											})
										}
									}
								})
								.finally(() => {
									running = false
								})

							if (outcome.ok) {
								const returned =
									outcome.returned ??
									[...handlesIn(outcome.result)].map(([handle, name]) => ({
										handle,
										name
									}))

								guard.record({
									tool,
									args,
									returned,
									created: outcome.created ?? []
								})
								handOut(returned)
								// The call reads as running until its content is extracted, which is a generation of its own.
								result =
									tool.untrustedOutput === "content"
										? await quarantine({
												model,
												request: message,
												earlier: answersEarlier(message) ? priorUser.at(-1) : undefined,
												source: extractionSource(tool),
												// Sanitized first: the quarantine prompt is rendered and tokenized like any other.
												result: sanitized(outcome.result),
												signal,
												onProgress
											})
										: outcome.result

								if (tool.effect !== "read") {
									ran.push({ name: call.name, arguments: call.arguments })
								}

								const listed = resultItemCount({
									tool,
									result: outcome.result
								})

								record = update(record, {
									status: "ok",
									...(listed === undefined
										? {}
										: {
												resultCount: listed.count,
												resultMore: listed.more
											})
								})
							} else {
								record = update(record, {
									status: outcome.invalid ? "invalid" : "error",
									error: outcome.error
								})
								result = failureResult(outcome)

								if (outcome.candidates !== undefined) {
									guard.recordCandidates(outcome.candidates)
									handOut(outcome.candidates)
								}
							}
						}
					}
				}

				// Also the check's errors: their candidates carry item names.
				if (tool.untrustedOutput !== "none") {
					result = untrusted(result)
				}
			}

			if (record.status === "invalid") {
				invalidThisStep = true
			}

			processed.push(call)
			results.push({
				role: "tool",
				toolCallId: call.id,
				content: serializeToolResult(result)
			})

			if (declined) {
				break
			}
		}

		discardUnfinished(new Set(processed.map(processedCall => processedCall.id)))
		turn.push(
			{
				role: "assistant",
				content: preamble,
				toolCalls: processed
			},
			...results
		)

		if (declined) {
			break
		}

		if (invalidThisStep) {
			if (retryUsed) {
				unrecovered = true

				break
			}

			retryUsed = true
		}

		// Repeating a call the guard refused gets nowhere; stop and let the model explain.
		if (blockedThisStep === stepCalls.length) {
			blockedSteps++

			if (blockedSteps >= 2) {
				break
			}
		}

		if (step === MAX_STEPS) {
			stepCapHit = true
		}
	}

	// The user always gets a reply: after the step cap, a refusal or a failed retry, one tool-less turn.
	if (answer.length === 0) {
		checkAborted(signal)
		onEvent({
			type: "phase",
			phase: "replying"
		})

		const closing = await generateSettled(
			model,
			{
				messages: fitMessages({
					system,
					history: past,
					// Without it, a model whose turn so far was all tool calls tends to write another one.
					turn:
						calls.length > 0 || callOnly
							? [
									...turn,
									{
										role: "user",
										content: ASSISTANT_CLOSING_NUDGE
									}
								]
							: turn,
					tools,
					maxTokens: stepTokens,
					contextTokens: model.contextTokens,
					...(fullPrompt === prompt ? {} : { fullPrompt }),
					onStub: forgetStubbed
				}),
				// Rendered, never called: the prompt then continues the last step's, which the engine has read.
				...(tools.length > 0
					? {
							tools,
							toolChoice: "none" as const
						}
					: {}),
				slot: "main",
				maxTokens: stepTokens
			},
			{
				signal,
				onText: streamReply,
				onProgress
			}
		)
		// This generation may not call tools, so call syntax in it is dropped and the text around it kept.
		const text = stripCallSyntax(closing.content, renderedNames)

		answer = closing.truncated === true && text.length > 0 ? markCut(text) : text
	}

	const final = replyEvent(answer, true)
	const withheld = final.type === "reply" && final.withheld === true

	onEvent(final)

	return {
		reply: final.type === "reply" ? final.text : "",
		historyReply: withheld ? "" : replyWithHandles(screen(answer, { handles: true }).text, handedOut),
		historyCalls: withheld ? [] : ran,
		prompt,
		withheld,
		route,
		intent,
		calls,
		unrecovered,
		stepCapHit
	}
}

// Runs the extraction over a result's content fields with no tools; only its answer reaches the main loop.
async function quarantine({
	model,
	request,
	earlier,
	source,
	result,
	signal,
	onProgress
}: {
	model: AssistantModel
	request: string
	// The user's previous message, for a reply to a clarifying question.
	earlier: string | undefined
	source: AssistantExtractionSource
	result: unknown
	signal: AssistantSignal
	onProgress: (progress: AssistantPromptProgress) => void
}): Promise<unknown> {
	if (typeof result !== "object" || result === null) {
		return result
	}

	const record = result as Record<string, unknown>
	// A pasted text as the request would crowd out the content; its start and end carry the ask.
	const asked = messageEdges(request)
	const background = earlier === undefined ? undefined : messageEdges(earlier.replace(/\s+/g, " ").trim())
	const frame = quarantinedExtractionPrompt({
		request: asked,
		earlier: background,
		source,
		data: ""
	})
	const budget =
		QUARANTINE_CONTEXT_TOKENS - QUARANTINE_MAX_TOKENS - estimateTokens(frame.system + frame.user) - MESSAGE_OVERHEAD_TOKENS * 2
	// A clipped chat keeps its newest messages, other content its start.
	const { data, clipped } =
		("content" in record ? undefined : messageLines(record["messages"], budget)) ??
		clipData(
			CONTENT_FIELDS.filter(field => field in record)
				.map(field => (typeof record[field] === "string" ? String(record[field]) : JSON.stringify(record[field])))
				.join("\n"),
			budget,
			"messages" in record
		)

	if (data.length === 0 && !clipped) {
		return result
	}

	const { system, user } = quarantinedExtractionPrompt({
		request: asked,
		earlier: background,
		source,
		data
	})
	const extracted = await generateSettled(
		model,
		{
			messages: [
				{
					role: "system",
					content: system
				},
				{
					role: "user",
					content: user
				}
			],
			slot: "extraction",
			maxTokens: QUARANTINE_MAX_TOKENS
		},
		{
			signal,
			onProgress
		}
	)

	return {
		...Object.fromEntries(Object.entries(record).filter(([key]) => !CONTENT_FIELDS.includes(key))),
		extract: extracted.content.trim(),
		// Tells the model the extract covers only part of the content, or stopped at its length limit.
		...(clipped || extracted.truncated === true
			? {
					extract_incomplete: true
				}
			: {})
	}
}
