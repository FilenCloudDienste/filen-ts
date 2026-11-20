import {
	ASSISTANT_WEB_TOOLS,
	isAssistantWebTool,
	runAssistantTurn,
	windowHistory,
	type AssistantChatMessage,
	type AssistantGenerateRequest,
	type AssistantGenerateResult,
	type AssistantHistoryTurn,
	type AssistantModel,
	type AssistantSignal,
	type AssistantTool,
	type AssistantToolCallRecord,
	type AssistantToolExecutor,
	type AssistantToolOutcome
} from "@filen/shared/assistant"
import {
	LlamaChat,
	LlamaText,
	TokenBias,
	type ChatHistoryItem,
	type ChatModelFunctionCall,
	type ChatModelFunctions,
	type ChatModelResponse,
	type ChatWrapper,
	type Llama,
	type LlamaContextSequence,
	type LlamaGrammar,
	type LlamaModel
} from "node-llama-cpp"
import type { CallRecord, CallStatus, Timings, Transcript, TurnTimings } from "./agent"
import type { EvalCase, StateCheck } from "./cases/types"
import type { FakeApp } from "./fakeApp"
import { allHandles } from "./fixture"
import { EVAL_NOW, EVAL_TIME_ZONE, PROMPT_CANARY } from "./prompts"

// The eval driving the loop the apps ship (@filen/shared/assistant runAssistantTurn): its router, guard,
// grounding, taint, quarantine, reply screen, history and context handling, over node-llama-cpp and the
// fake app. agent.ts stays for the presets that switch mitigations off, which the shipping loop cannot.

// "shipped": the tools the web app runs (the writes it has no card for are not offered and the prompt says so).
// "loop": every tool, as an app with all write adapters would run them.
export const LOOP_PRESETS = {
	shipped: {
		supports: (tool: AssistantTool) => isAssistantWebTool(tool.name)
	},
	loop: {
		supports: (_tool: AssistantTool) => true
	}
} as const

export type LoopPreset = keyof typeof LOOP_PRESETS

export function isLoopPreset(name: string): name is LoopPreset {
	return Object.hasOwn(LOOP_PRESETS, name)
}

export type LoopRuntime = {
	llama: Llama
	routerSequence: LlamaContextSequence
	mainSequence: LlamaContextSequence
	quarantineSequence: LlamaContextSequence
	createWrapper: () => ChatWrapper
	specialTokens: readonly string[]
	contextTokens: number
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown
	} catch {
		return text
	}
}

// The loop's engine-neutral messages as node-llama-cpp's chat history: a tool result goes onto the call it
// answers, inside the model turn that made it.
export function toHistory(messages: readonly AssistantChatMessage[], parallel: boolean): ChatHistoryItem[] {
	const history: ChatHistoryItem[] = []
	const pending = new Map<string, ChatModelFunctionCall>()

	for (const message of messages) {
		switch (message.role) {
			case "system":
				history.push({ type: "system", text: message.content })
				break
			case "user":
				history.push({ type: "user", text: message.content })
				break
			case "assistant": {
				const response: ChatModelResponse["response"] = message.content.length > 0 ? [message.content] : []

				for (const [index, call] of (message.toolCalls ?? []).entries()) {
					const functionCall: ChatModelFunctionCall = {
						type: "functionCall",
						name: call.name,
						params: parseJson(call.arguments),
						result: null,
						...(index === 0 && parallel ? { startsNewChunk: true } : {})
					}

					pending.set(call.id, functionCall)
					response.push(functionCall)
				}

				history.push({ type: "model", response })
				break
			}
			case "tool": {
				const functionCall = pending.get(message.toolCallId)

				if (functionCall !== undefined) {
					functionCall.result = parseJson(message.content)
				}

				break
			}
		}
	}

	// A request ends on the user's turn; the template opens the model's.
	return history
}

// A request that must call: the web worker's engine opens the reply with the template's call opener and
// constrains the rest to a call (tool_choice "required"). node-llama-cpp has neither, so the opener is made
// the first token and the model writes the call itself, in the tokens it would have chosen ("=list" is one
// token; an injected "<function=" would split it and change which tool the model picks).
const OPENER_LOGIT = 100

function openerBias(model: LlamaModel, wrapper: ChatWrapper): TokenBias {
	const opener = LlamaText(wrapper.settings.functions.call.prefix).tokenize(model.tokenizer, "trimLeadingSpace")[0]

	// A token of its own, as Qwen's "<tool_call>": a plain first character would open far more than calls.
	if (opener === undefined || model.detokenize([opener], true).length < 2) {
		throw new Error(`${wrapper.wrapperName} opens calls without a token of their own; a required call needs its own handling`)
	}

	return new TokenBias(model.tokenizer).set(opener, { logit: OPENER_LOGIT })
}

// AssistantModel over node-llama-cpp: one sequence per kind of request, as the web worker keeps one slot
// per kind, and the same measurements agent.ts takes.
export class LlamaAssistantModel implements AssistantModel {
	readonly contextTokens: number
	readonly specialTokens: readonly string[]
	readonly timings: Timings = {
		routerMs: 0,
		routerTtftMs: 0,
		firstStepTtftMs: null,
		totalMs: 0,
		generations: 0,
		inputTokens: 0,
		outputTokens: 0,
		decodeMs: 0
	}
	mainGenerations = 0
	extractions = 0
	private readonly runtime: LoopRuntime
	private readonly wrapper: ChatWrapper
	private readonly chats: Record<AssistantGenerateRequest["slot"], LlamaChat>
	private opener: TokenBias | undefined
	private readonly grammars = new Map<string, Promise<LlamaGrammar>>()

	constructor(runtime: LoopRuntime) {
		this.runtime = runtime
		this.contextTokens = runtime.contextTokens
		this.specialTokens = runtime.specialTokens
		this.wrapper = runtime.createWrapper()
		this.chats = {
			router: new LlamaChat({ contextSequence: runtime.routerSequence, chatWrapper: this.wrapper, autoDisposeSequence: false }),
			main: new LlamaChat({ contextSequence: runtime.mainSequence, chatWrapper: this.wrapper, autoDisposeSequence: false }),
			extraction: new LlamaChat({
				contextSequence: runtime.quarantineSequence,
				chatWrapper: this.wrapper,
				autoDisposeSequence: false
			})
		}
	}

	dispose(): void {
		for (const chat of Object.values(this.chats)) {
			chat.dispose({ disposeSequence: false })
		}
	}

	private grammar(source: string): Promise<LlamaGrammar> {
		let grammar = this.grammars.get(source)

		if (grammar === undefined) {
			grammar = this.runtime.llama.createGrammar({ grammar: source })
			this.grammars.set(source, grammar)
		}

		return grammar
	}

	async generate(
		request: AssistantGenerateRequest,
		{ signal, onText }: { signal: AssistantSignal; onText?: (text: string) => void }
	): Promise<AssistantGenerateResult> {
		const functions: ChatModelFunctions | undefined =
			request.tools === undefined || request.tools.length === 0
				? undefined
				: Object.fromEntries(request.tools.map(tool => [tool.name, { description: tool.description, params: tool.parameters }]))
		const chat = this.chats[request.slot]
		const sequence = chat.sequence
		// Only the first token is the opener's; the rest is sampled as usual.
		let opening =
			request.toolChoice === "required" && functions !== undefined
				? (this.opener ??= openerBias(sequence.model, this.wrapper))
				: undefined
		const unbiased = new TokenBias(sequence.model.tokenizer)
		const grammar = request.grammar === undefined ? undefined : await this.grammar(request.grammar)
		const inputBefore = sequence.tokenMeter.usedInputTokens
		const outputBefore = sequence.tokenMeter.usedOutputTokens
		const started = performance.now()
		let first: number | null = null
		let text = ""
		const onFirst = () => {
			first ??= performance.now()
		}
		const history = toHistory(request.messages, this.wrapper.settings.functions.parallelism !== undefined)
		const common = {
			temperature: 0,
			maxTokens: request.maxTokens,
			budgets: { thoughtTokens: 0 },
			...(signal instanceof AbortSignal ? { signal } : {}),
			...(opening === undefined
				? {}
				: {
						tokenBias: () => {
							const bias = opening ?? unbiased

							opening = undefined

							return bias
						}
					}),
			onToken: onFirst,
			onTextChunk: (chunk: string) => {
				text += chunk
				onText?.(text)
			}
		}
		const response =
			grammar !== undefined
				? await chat.generateResponse(history, { ...common, grammar })
				: functions !== undefined
					? await chat.generateResponse(history, { ...common, functions, onFunctionCallParamsChunk: onFirst })
					: await chat.generateResponse(history, common)
		const ended = performance.now()
		const ttft = first === null ? null : first - started

		this.timings.generations++
		this.timings.inputTokens += sequence.tokenMeter.usedInputTokens - inputBefore
		this.timings.outputTokens += sequence.tokenMeter.usedOutputTokens - outputBefore
		this.timings.decodeMs += ended - (first ?? ended)

		if (request.slot === "router") {
			this.timings.routerMs += ended - started
			this.timings.routerTtftMs += ttft ?? ended - started
		} else if (request.slot === "main") {
			if (this.mainGenerations === 0) {
				this.timings.firstStepTtftMs = ttft
			}

			this.mainGenerations++
		} else {
			this.extractions++
		}

		// A request that may call nothing (toolChoice "none") gets its calls back as text, as an engine that
		// parses no calls hands them back; the loop drops call syntax from it.
		const parsed = response.functionCalls ?? []
		const none = request.toolChoice === "none"
		const calls = none ? [] : parsed
		const written = none
			? parsed
					.map(call => `<tool_call>\n${JSON.stringify({ name: call.functionName, arguments: call.params ?? {} })}\n</tool_call>`)
					.join("\n")
			: ""

		return {
			content: written.length === 0 ? response.response : `${response.response}\n${written}`.trim(),
			toolCalls: calls.map((call, index) => ({
				id: `nl_${String(this.timings.generations)}_${String(index)}`,
				name: call.functionName,
				arguments: JSON.stringify(call.params ?? {})
			})),
			...(response.metadata.stopReason === "maxTokens" ? { truncated: true } : {})
		}
	}
}

// AssistantToolExecutor over the fake app, checking calls as the web executor does: paths resolve to
// handles, unknown handles come back as invalid with candidates, a tool the app does not run is refused.
export class FakeAppExecutor implements AssistantToolExecutor {
	private readonly app: FakeApp
	private readonly allowed: (tool: AssistantTool) => boolean

	constructor(app: FakeApp, supports: (tool: AssistantTool) => boolean) {
		this.app = app
		this.allowed = supports
	}

	// Only what the context line names, as the web executor's: a handle an earlier turn listed is grounded by
	// that turn's lookup, never by the context of a later one.
	context(): Promise<{ description: string; handles: readonly string[] }> {
		return Promise.resolve({ description: this.app.describeContext(), handles: this.app.contextHandles() })
	}

	supports(tool: AssistantTool): boolean {
		return this.allowed(tool)
	}

	name(handle: string): string | undefined {
		const { drive, notes, chats, playlists } = this.app.state

		return (
			drive.find(item => item.handle === handle)?.name ??
			notes.find(item => item.handle === handle)?.title ??
			chats.find(item => item.handle === handle)?.name ??
			playlists.find(item => item.handle === handle)?.name
		)
	}

	check({ tool, args }: { tool: AssistantTool; args: Record<string, unknown> }): ReturnType<AssistantToolExecutor["check"]> {
		if (!this.allowed(tool)) {
			const error = `"${tool.title}" is not available yet; the user can do it in the app`

			return Promise.resolve({ ok: false, invalid: false, error, result: { error } })
		}

		const resolved = this.app.resolvePaths(args)
		const unknown = this.app.checkHandles({ tool: tool.name, args: resolved })

		if (unknown !== null && !unknown.ok) {
			return Promise.resolve({
				ok: false,
				invalid: unknown.invalid,
				error: unknown.error,
				...(unknown.candidates === undefined ? {} : { candidates: unknown.candidates })
			})
		}

		return Promise.resolve({ ok: true, args: resolved })
	}

	execute({ tool, args }: { tool: AssistantTool; args: Record<string, unknown> }): Promise<AssistantToolOutcome> {
		const before = allHandles(this.app.state)
		const outcome = this.app.execute({ name: tool.name, args })

		if (!outcome.ok) {
			return Promise.resolve({
				ok: false,
				invalid: outcome.invalid,
				error: outcome.error,
				...(outcome.candidates === undefined ? {} : { candidates: outcome.candidates })
			})
		}

		return Promise.resolve({
			ok: true,
			result: outcome.result,
			...(outcome.returned === undefined ? {} : { returned: outcome.returned }),
			created: [...allHandles(this.app.state)].filter(handle => !before.has(handle))
		})
	}
}

const STATUS: Partial<Record<AssistantToolCallRecord["status"], CallStatus>> = {
	ok: "ok",
	error: "error",
	invalid: "invalid",
	blocked: "blocked",
	// Not run again: as good as refused, for the graders.
	repeated: "blocked",
	declined: "blocked"
}

function callRecord(record: AssistantToolCallRecord, stepOffset: number): CallRecord {
	return {
		step: record.step + stepOffset,
		tool: record.tool,
		args: record.args,
		status: STATUS[record.status] ?? "error",
		consequential: record.consequential,
		...(record.error === undefined ? {} : { error: record.error })
	}
}

// Runs the case's message, then each follow-up as the next turn of the same conversation, the way the web
// session does: history carries each exchange as the model read it. Calls of every turn count; the last
// reply is the answer and the earlier ones are shown replies, as the user saw them all.
export async function runLoopTurns({
	runtime,
	app,
	prompts,
	preset
}: {
	runtime: LoopRuntime
	app: FakeApp
	prompts: readonly string[]
	preset: LoopPreset
}): Promise<Transcript> {
	const started = performance.now()
	const model = new LlamaAssistantModel(runtime)
	const executor = new FakeAppExecutor(app, LOOP_PRESETS[preset].supports)
	let history: AssistantHistoryTurn[] = []
	const calls: CallRecord[] = []
	const replies: string[] = []
	const answers: string[] = []
	const turns: TurnTimings[] = []
	let last: Awaited<ReturnType<typeof runAssistantTurn>> | null = null

	try {
		for (const message of prompts) {
			const turnStarted = performance.now()
			const { routerMs, routerTtftMs, inputTokens } = model.timings
			const offset = calls.reduce((max, call) => Math.max(max, call.step), 0)
			const shown: string[] = []
			const result = await runAssistantTurn({
				model,
				executor,
				history,
				message,
				signal: new AbortController().signal,
				onEvent: event => {
					if (event.type === "reply" && event.final && event.text.length > 0) {
						shown.push(event.text)
					}
				},
				// The worst case: a user who confirms whatever card reaches them.
				confirm: () => Promise.resolve(true),
				nonce: () => PROMPT_CANARY,
				secrets: { canary: PROMPT_CANARY },
				now: EVAL_NOW,
				timeZone: EVAL_TIME_ZONE,
				weekStart: 1
			})

			calls.push(...result.calls.map(record => callRecord(record, offset)))
			// Every reply the turn showed besides its answer, which is the last one shown.
			replies.push(...(result.reply.length > 0 ? shown.slice(0, -1) : shown))
			answers.push(result.reply)
			turns.push({
				totalMs: performance.now() - turnStarted,
				routerMs: model.timings.routerMs - routerMs,
				routerTtftMs: model.timings.routerTtftMs - routerTtftMs,
				inputTokens: model.timings.inputTokens - inputTokens
			})
			// As the web session keeps it: a turn that replied, windowed to the history budget.
			if (result.withheld || result.reply.trim().length > 0) {
				history = windowHistory([
					...history,
					{ user: message, reply: result.historyReply, prompt: result.prompt, calls: result.historyCalls }
				])
			}

			last = result
		}
	} finally {
		model.dispose()
	}

	model.timings.totalMs = performance.now() - started

	return {
		route: last?.route ?? null,
		intent: last?.intent ?? null,
		routeRaw: `${last?.route ?? "?"} ${last?.intent ?? ""}`.trim(),
		calls,
		answer: last?.reply ?? "",
		// An earlier turn's answer was shown to the user as well.
		replies: [...replies, ...answers.slice(0, -1).filter(answer => answer.length > 0)],
		lastTurnCalls: last?.calls.length ?? 0,
		invalidOutputs: calls.filter(call => call.status === "invalid").length,
		unrecovered: last?.unrecovered ?? false,
		steps: model.mainGenerations,
		stepCapHit: last?.stepCapHit ?? false,
		quarantineCalls: model.extractions,
		timings: model.timings,
		turns
	}
}

// Whether the web app's tools can make a change the case expects: a note's pin, favorite or archive flag
// (set_note_flags) and a playlist's tracks (add_tracks_to_playlist) are not among them.
function webChanges(check: StateCheck): boolean {
	if ("note" in check) {
		return check.pinned === undefined && check.favorite === undefined && check.archived === undefined
	}

	return !("playlist" in check)
}

// A case as the web app can pass it: one that needs a write the app does not run asks for a plain reply
// instead (the prompt tells the model the action is not available), with no change to the data, routed as the
// request would be (`unavailableWrite`; the report lists these apart from the pass rate). Reads, drafts and
// the writes the app runs are graded as written.
export function shippedCase(evalCase: EvalCase): EvalCase {
	const tools = (evalCase.calls ?? []).flatMap(option => ("anyOf" in option ? option.anyOf.map(call => call.tool) : [option.tool]))
	const unreachableState = (evalCase.state ?? []).some(check => !webChanges(check))
	const unsupported = tools.some(tool => !(ASSISTANT_WEB_TOOLS as readonly string[]).includes(tool))

	if (!unsupported && !unreachableState) {
		return evalCase
	}

	const { calls: _calls, state: _state, mayChange: _mayChange, answerIncludes: _answerIncludes, ...rest } = evalCase

	return { ...rest, expectsText: true, unavailableWrite: true }
}
