import {
	ASSISTANT_WEB_TOOLS,
	isAssistantWebTool,
	runActOnRead,
	runAssistantTurn,
	transformText,
	windowHistory,
	type AssistantActOnReadAction,
	type AssistantActOnReadRequest,
	type AssistantGenerateRequest,
	type AssistantGenerateResult,
	type AssistantHistoryTurn,
	type AssistantModel,
	type AssistantSignal,
	type AssistantTool,
	type AssistantToolCallRecord,
	type AssistantToolExecutor,
	type AssistantToolOutcome,
	type AssistantTurnResult
} from "@filen/shared/assistant"
import { LlamaSlotModel, toHistory } from "@filen/assistant-node"
import type { ChatWrapper, Llama, LlamaContextSequence } from "node-llama-cpp"
import type { CallRecord, CallStatus, Timings, Transcript, TurnTimings } from "./agent"
import type { EvalCase } from "./cases/types"
import type { FakeApp } from "./fakeApp"
import { allHandles } from "./fixture"
import { EVAL_NOW, EVAL_TIME_ZONE, PROMPT_CANARY } from "./prompts"

// The eval driving the loop the apps ship (@filen/shared/assistant runAssistantTurn): its router, guard,
// grounding, taint, quarantine, reply screen, history and context handling, over node-llama-cpp and the
// fake app. agent.ts stays for the presets that switch mitigations off, which the shipping loop cannot.

// "shipped": the tools the web app runs (a write it has no card for is not offered and the prompt says so).
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

// The loop's messages as node-llama-cpp's chat history, as the desktop app's engine maps them.
export { toHistory }

// The desktop app's engine (LlamaSlotModel, @filen/assistant-node) with the eval's timings around each request.
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
	private readonly slots: LlamaSlotModel

	constructor(runtime: LoopRuntime) {
		this.contextTokens = runtime.contextTokens
		this.specialTokens = runtime.specialTokens
		this.slots = new LlamaSlotModel({
			llama: runtime.llama,
			sequences: { router: runtime.routerSequence, main: runtime.mainSequence, extraction: runtime.quarantineSequence },
			wrapper: runtime.createWrapper()
		})
	}

	dispose(): void {
		this.slots.dispose()
	}

	async generate(
		request: AssistantGenerateRequest,
		{ signal, onText }: { signal: AssistantSignal; onText?: (text: string) => void }
	): Promise<AssistantGenerateResult> {
		const sequence = this.slots.sequence(request.slot)
		const inputBefore = sequence.tokenMeter.usedInputTokens
		const outputBefore = sequence.tokenMeter.usedOutputTokens
		const started = performance.now()
		let first: number | null = null
		const result = await this.slots.generate(request, {
			signal,
			onFirstToken: () => {
				first ??= performance.now()
			},
			onUpdate: update => {
				if (update.type === "text") {
					onText?.(update.text)
				}
			}
		})
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

		return result
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
			playlists.find(item => item.handle === handle)?.name ??
			this.app.helpTitle(handle)
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
	preset,
	actOnRead
}: {
	runtime: LoopRuntime
	app: FakeApp
	prompts: readonly string[]
	preset: LoopPreset
	// After the last turn, the user clicks this button under its reply (when the reply offers it).
	actOnRead?: AssistantActOnReadAction | undefined
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

		if (actOnRead !== undefined && last !== null) {
			const request = actOnReadRequest({ action: actOnRead, result: last, executor })

			if (request !== null) {
				const offset = calls.reduce((max, call) => Math.max(max, call.step), 0)
				const acted = await runActOnRead({
					model,
					executor,
					request,
					originUserMessage: prompts.at(-1) ?? "",
					label: ACT_ON_READ_LABELS[actOnRead],
					signal: new AbortController().signal,
					onEvent: () => undefined,
					confirm: () => Promise.resolve(true)
				})

				calls.push(...acted.calls.map(record => callRecord(record, offset)))
			}
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

// How a click reads in the conversation, as the web app's buttons label it.
const ACT_ON_READ_LABELS: Readonly<Record<AssistantActOnReadAction, string>> = {
	save_note: "[Save as note]",
	draft_reply: "[Draft reply]"
}

// The button's request as the web session builds it (features/assistant/loop/session.ts): offered only under a
// reply written from content the turn read, Draft reply only after a chat was read. Null when not offered.
export function actOnReadRequest({
	action,
	result,
	executor
}: {
	action: AssistantActOnReadAction
	result: AssistantTurnResult
	executor: FakeAppExecutor
}): AssistantActOnReadRequest | null {
	if (result.withheld || result.readSources.length === 0 || result.reply.trim().length === 0) {
		return null
	}

	const sources = result.readSources.map(source => source.handle)
	const first = result.readSources[0]
	const chat = result.readSources.findLast(source => source.tool === "read_chat")

	if (action === "save_note") {
		const name = first === undefined ? undefined : executor.name(first.handle)

		return { action, title: name === undefined ? "Assistant summary" : `${name} – summary`, text: result.noteText, sources }
	}

	return chat === undefined ? null : { action, chat: chat.handle, payload: result.reply, sources }
}

// A case as the web app can pass it: one that calls a tool the app does not run asks for a plain reply instead
// (the prompt tells the model the action is not available), with no change to the data, routed as the request
// would be (`unavailableWrite`; the report lists these apart from the pass rate). Every other case is graded as
// written. The app runs every write in the shared set today, so this returns each case unchanged until a tool is
// added there without a web card.
export function shippedCase(evalCase: EvalCase): EvalCase {
	const tools = (evalCase.calls ?? []).flatMap(option => ("anyOf" in option ? option.anyOf.map(call => call.tool) : [option.tool]))
	const unsupported = tools.some(tool => !(ASSISTANT_WEB_TOOLS as readonly string[]).includes(tool))

	if (!unsupported) {
		return evalCase
	}

	const { calls: _calls, state: _state, mayChange: _mayChange, answerIncludes: _answerIncludes, ...rest } = evalCase

	return { ...rest, expectsText: true, unavailableWrite: true }
}

// A selection transform as the apps run it: transformText in the extraction slot, no tools, no router, no history.
export type TransformRun = {
	output: string
	truncated: boolean
	foreignLinks: string[]
	timings: Timings
}

export async function runTransformCase({
	runtime,
	item
}: {
	runtime: LoopRuntime
	item: Pick<Parameters<typeof transformText>[0], "kind" | "text" | "language">
}): Promise<TransformRun> {
	const started = performance.now()
	const model = new LlamaAssistantModel(runtime)

	try {
		const result = await transformText({
			model,
			kind: item.kind,
			text: item.text,
			language: item.language,
			signal: new AbortController().signal
		})

		return {
			output: result.text,
			truncated: result.truncated,
			foreignLinks: result.foreignLinks,
			timings: { ...model.timings, totalMs: performance.now() - started }
		}
	} finally {
		model.dispose()
	}
}
