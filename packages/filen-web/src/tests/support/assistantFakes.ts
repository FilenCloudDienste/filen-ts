// A scripted model, runtime and tool executor for driving the real assistant session in tests.

import { vi, type Mock } from "vitest"
import {
	ROUTER_GRAMMAR,
	type AssistantGenerateRequest,
	type AssistantGenerateResult,
	type AssistantModel,
	type AssistantModelToolCall,
	type AssistantSignal,
	type AssistantTool
} from "@filen/shared/assistant"
import type { AssistantRuntimeLike } from "@/features/assistant/loop/session"
import { unlessStopped } from "@/features/assistant/tools/format"
import type { AssistantToolExecution, AssistantToolPreview, ToolExecutor } from "@/features/assistant/runtime/executor"
import type { AssistantEvent, AssistantModelState } from "@/features/assistant/types"

type Step = string | AssistantModelToolCall[] | ((request: AssistantGenerateRequest) => AssistantModelToolCall[] | string)

export function call(name: string, args: Record<string, unknown>): AssistantModelToolCall[] {
	return [{ id: "x", name, arguments: JSON.stringify(args) }]
}

export type GenerateOptions = Parameters<AssistantModel["generate"]>[1]

// With `reports`, every generation reads its prompt in two progress reports and names its calls first,
// as wllama does.
export class ScriptedModel implements AssistantModel {
	readonly contextTokens = 8192
	readonly specialTokens = ["<|im_end|>"]
	private readonly steps: Step[]
	private readonly route: string
	private readonly reports: boolean

	constructor({ route, steps, reports = false }: { route: string; steps: Step[]; reports?: boolean }) {
		this.route = route
		this.steps = steps.slice()
		this.reports = reports
	}

	generate(request: AssistantGenerateRequest, options: GenerateOptions): Promise<AssistantGenerateResult> {
		if (this.reports) {
			options.onProgress?.({ processed: 0, total: 40 })
			options.onProgress?.({ processed: 40, total: 40 })
		}

		if (request.grammar === ROUTER_GRAMMAR) {
			return Promise.resolve({ content: this.route, toolCalls: [] })
		}

		if (request.messages[0]?.content.startsWith("Answer the user's request using only the data below")) {
			return Promise.resolve({ content: "They asked to be messaged.", toolCalls: [] })
		}

		const next = this.steps.shift() ?? "Done."
		const step = typeof next === "function" ? next(request) : next

		if (typeof step === "string") {
			options.onText?.(step)

			return Promise.resolve({ content: step, toolCalls: [] })
		}

		if (this.reports) {
			for (const [index, toolCall] of step.entries()) {
				options.onToolCall?.({ index, name: toolCall.name })
			}
		}

		return Promise.resolve({ content: "", toolCalls: step })
	}
}

export const INFO = { id: "m", name: "M", sizeBytes: 1 }

export type FakeRuntime = Omit<AssistantRuntimeLike, "load" | "touch" | "setPanelOpen"> & {
	holds: number
	// Each release's `activity`, in order.
	releases: boolean[]
	state: AssistantModelState
	load: Mock<() => Promise<void>>
	touch: Mock<() => void>
	setPanelOpen: Mock<(open: boolean) => void>
}

// Ready unless given another state; a load settles in "ready" unless the test replaces it.
export function fakeRuntime(model: AssistantModel, initial: AssistantModelState = { kind: "ready", model: INFO }): FakeRuntime {
	const runtime: FakeRuntime = {
		holds: 0,
		releases: [],
		state: initial,
		model,
		getState: () => runtime.state,
		subscribe: () => () => undefined,
		init: () => Promise.resolve(),
		setPanelOpen: vi.fn<(open: boolean) => void>(),
		load: vi.fn(() => {
			runtime.state = { kind: "ready", model: INFO }

			return Promise.resolve()
		}),
		touch: vi.fn<() => void>(),
		retry: vi.fn(),
		resumeInterruptedDownload: vi.fn(),
		cancelDownload: vi.fn(),
		deleteModel: vi.fn(() => Promise.resolve()),
		shutdown: vi.fn(),
		hold: () => {
			runtime.holds++

			let released = false

			return ({ activity = true } = {}) => {
				if (!released) {
					released = true
					runtime.holds--
					runtime.releases.push(activity)
				}
			}
		}
	}

	return runtime
}

export const NAMES: Record<string, string> = { c1: "Maria", c2: "Attacker", n1: "Plan" }

export interface Executed {
	call: { name: string; args: Record<string, unknown> }
	confirmed: boolean
}

// A tool executor over three items; read results come from `results`. set_note_flags has no adapter yet.
export function fakeExecutor(results: Record<string, unknown> = {}): ToolExecutor & { executed: Executed[] } {
	const executed: Executed[] = []

	return {
		executed,
		context: () => Promise.resolve({ description: "screen: chats", handles: ["d0"] }),
		check: ({ tool, args }: { tool: AssistantTool; args: Record<string, unknown> }) => {
			if (tool.name === "set_note_flags") {
				return Promise.resolve({ ok: false as const, invalid: false, error: "not available yet" })
			}

			return Promise.resolve({ ok: true as const, args })
		},
		preview: ({ args }: { tool: AssistantTool; args: Record<string, unknown> }): Promise<AssistantToolPreview> => {
			const values = Object.values(args).flatMap(value => (Array.isArray(value) ? (value as unknown[]) : [value]))
			const targets = values
				.filter((value): value is string => typeof value === "string" && value in NAMES)
				.map(handle => ({ handle, name: NAMES[handle] ?? handle }))
			const text = Object.fromEntries(
				Object.entries(args).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !(entry[1] in NAMES))
			)

			return Promise.resolve({ ok: true, title: "t", targets, text })
		},
		// Settles as stopped once its signal aborts, as the app's executor does.
		execute: ({
			tool,
			args,
			confirmed,
			signal
		}: {
			tool: AssistantTool
			args: Record<string, unknown>
			confirmed: boolean
			signal?: AssistantSignal
		}): Promise<AssistantToolExecution> => {
			executed.push({ call: { name: tool.name, args }, confirmed })

			const value = results[tool.name] ?? { done: true }
			const done = Promise.resolve<AssistantToolExecution>({ ok: true, result: value })

			return signal === undefined ? done : unlessStopped(done, signal)
		},
		reset: vi.fn()
	}
}

export function waitFor(events: AssistantEvent[], predicate: (event: AssistantEvent) => boolean): Promise<AssistantEvent> {
	return vi.waitFor(
		() => {
			const found = events.find(predicate)

			if (found === undefined) {
				throw new Error("not yet")
			}

			return found
		},
		{ interval: 1 }
	)
}
