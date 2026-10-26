import {
	ASSISTANT_TOOL_GROUPS,
	ASSISTANT_TOOLS,
	assistantToolByName,
	AssistantTurnGuard,
	isConsequentialTool,
	mapUntrustedStrings,
	extractionSource,
	parseToolInput,
	quarantinedExtractionPrompt,
	sanitizeUntrustedText,
	screenAssistantReply,
	spotlightInstruction,
	spotlightText,
	toolInputJsonSchema,
	type AssistantExtractionSource,
	type AssistantRoute,
	type AssistantTool,
	type AssistantToolGroup,
	type SpotlightOptions
} from "@filen/shared/assistant"
import {
	LlamaChat,
	type ChatHistoryItem,
	type ChatModelFunctionCall,
	type ChatModelFunctions,
	type ChatWrapper,
	type LlamaContextSequence,
	type LlamaGrammar
} from "node-llama-cpp"
import { DECOY_TOOLS } from "./decoys"
import type { FakeApp } from "./fakeApp"
import {
	ASSISTANT_CLOSING_NUDGE,
	ASSISTANT_MALFORMED_RETRY,
	assistantSystemPrompt,
	evalUserPrompt,
	PROMPT_CANARY,
	ROUTER_SYSTEM_PROMPT
} from "./prompts"

export type Mitigations = {
	// Off reproduces engines that parse special tokens inside tool results.
	sanitize: boolean
	spotlight: "off" | "delimit" | "datamark"
	quarantine: boolean
	taintGate: boolean
	grounding: boolean
	// Router intent decides whether consequential tools are offered at all.
	scope: boolean
	// Off offers every tool whatever the router picked: a stress test for when routing is wrong.
	groupScoping: boolean
}

export const MITIGATION_PRESETS = {
	none: {
		sanitize: false,
		spotlight: "off",
		quarantine: false,
		taintGate: false,
		grounding: false,
		scope: false,
		groupScoping: true
	},
	sanitize: {
		sanitize: true,
		spotlight: "off",
		quarantine: false,
		taintGate: false,
		grounding: false,
		scope: false,
		groupScoping: true
	},
	delimit: {
		sanitize: false,
		spotlight: "delimit",
		quarantine: false,
		taintGate: false,
		grounding: false,
		scope: false,
		groupScoping: true
	},
	datamark: {
		sanitize: false,
		spotlight: "datamark",
		quarantine: false,
		taintGate: false,
		grounding: false,
		scope: false,
		groupScoping: true
	},
	quarantine: {
		sanitize: false,
		spotlight: "off",
		quarantine: true,
		taintGate: false,
		grounding: false,
		scope: false,
		groupScoping: true
	},
	taint: {
		sanitize: false,
		spotlight: "off",
		quarantine: false,
		taintGate: true,
		grounding: false,
		scope: false,
		groupScoping: true
	},
	grounding: {
		sanitize: false,
		spotlight: "off",
		quarantine: false,
		taintGate: false,
		grounding: true,
		scope: false,
		groupScoping: true
	},
	scope: {
		sanitize: false,
		spotlight: "off",
		quarantine: false,
		taintGate: false,
		grounding: false,
		scope: true,
		groupScoping: true
	},
	flat_none: {
		sanitize: false,
		spotlight: "off",
		quarantine: false,
		taintGate: false,
		grounding: false,
		scope: false,
		groupScoping: false
	},
	flat_all: {
		sanitize: true,
		spotlight: "delimit",
		quarantine: true,
		taintGate: true,
		grounding: true,
		scope: true,
		groupScoping: false
	},
	all: {
		sanitize: true,
		spotlight: "delimit",
		quarantine: true,
		taintGate: true,
		grounding: true,
		scope: true,
		groupScoping: true
	}
} as const satisfies Record<string, Mitigations>

export type MitigationPreset = keyof typeof MITIGATION_PRESETS

export type CallStatus = "ok" | "error" | "invalid" | "blocked"

export type CallRecord = {
	step: number
	tool: string
	args: unknown
	status: CallStatus
	consequential: boolean
	error?: string
}

export type Timings = {
	routerMs: number
	routerTtftMs: number
	firstStepTtftMs: number | null
	totalMs: number
	generations: number
	inputTokens: number
	outputTokens: number
	decodeMs: number
}

export type Transcript = {
	route: AssistantRoute | null
	intent: "read" | "change" | null
	routeRaw: string
	calls: CallRecord[]
	answer: string
	// Text written alongside tool calls: the app shows each as a reply of its own. Absent in older records.
	replies?: string[]
	// Calls the last turn of a conversation made. Absent in older records and for one-turn runs.
	lastTurnCalls?: number
	invalidOutputs: number
	unrecovered: boolean
	steps: number
	stepCapHit: boolean
	quarantineCalls: number
	timings: Timings
}

export type AgentRuntime = {
	routerSequence: LlamaContextSequence
	mainSequence: LlamaContextSequence
	quarantineSequence: LlamaContextSequence
	routerGrammar: LlamaGrammar
	createWrapper: () => ChatWrapper
	specialTokens: readonly string[]
}

const MAX_STEPS = 5
const STEP_MAX_TOKENS = 384
const QUARANTINE_MAX_TOKENS = 200

const MALFORMED_CALL =
	/<tool_call>|<\|tool_call_start\|>|<function=|\|\|call:|"name"\s*:\s*"[a-z_]+"\s*,\s*"(?:arguments|parameters)"|\b[a-z]+_[a-z_]+\s*\(\s*(?:[a-z_]+\s*=|\{)/

type Generation = {
	ttftMs: number | null
	durationMs: number
}

// Wraps one generateResponse call with timing and token accounting.
async function measured<T>({
	sequence,
	timings,
	run
}: {
	sequence: LlamaContextSequence
	timings: Timings
	run: (onFirst: () => void) => Promise<T>
}): Promise<T & Generation> {
	const inputBefore = sequence.tokenMeter.usedInputTokens
	const outputBefore = sequence.tokenMeter.usedOutputTokens
	const started = performance.now()
	let first: number | null = null
	const result = await run(() => {
		first ??= performance.now()
	})
	const ended = performance.now()

	timings.generations++
	timings.inputTokens += sequence.tokenMeter.usedInputTokens - inputBefore
	timings.outputTokens += sequence.tokenMeter.usedOutputTokens - outputBefore
	timings.decodeMs += ended - (first ?? ended)

	return {
		...result,
		ttftMs: first === null ? null : first - started,
		durationMs: ended - started
	}
}

function toFunctions(tools: readonly AssistantTool[]): ChatModelFunctions {
	return Object.fromEntries(
		tools.map(tool => [
			tool.name,
			{
				description: tool.description,
				params: toolInputJsonSchema(tool)
			}
		])
	)
}

function appendCalls({
	history,
	calls,
	startsNewChunk
}: {
	history: ChatHistoryItem[]
	calls: ChatModelFunctionCall[]
	startsNewChunk: boolean
}): ChatHistoryItem[] {
	const next = history.slice()
	const last = next.at(-1)
	const model = last?.type === "model" ? last : null
	const response = [
		...(model?.response ?? []),
		...calls.map((call, index) => (index === 0 && startsNewChunk ? { ...call, startsNewChunk: true } : call))
	]

	if (model === null) {
		next.push({
			type: "model",
			response
		})
	} else {
		next[next.length - 1] = {
			type: "model",
			response
		}
	}

	return next
}

function handlesIn(value: unknown, found: Map<string, string> = new Map()): Map<string, string> {
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

function allHandles(app: FakeApp): Set<string> {
	return new Set([...app.state.drive.map(item => item.handle), ...app.state.notes.map(item => item.handle)])
}

const CONTENT_FIELDS = ["content", "messages"]

export async function runTurn({
	runtime,
	app,
	prompt,
	mitigations,
	injectionTools
}: {
	runtime: AgentRuntime
	app: FakeApp
	prompt: string
	mitigations: Mitigations
	injectionTools: boolean
}): Promise<Transcript> {
	const started = performance.now()
	const timings: Timings = {
		routerMs: 0,
		routerTtftMs: 0,
		firstStepTtftMs: null,
		totalMs: 0,
		generations: 0,
		inputTokens: 0,
		outputTokens: 0,
		decodeMs: 0
	}
	const wrapper = runtime.createWrapper()
	const routerChat = new LlamaChat({
		contextSequence: runtime.routerSequence,
		chatWrapper: wrapper,
		autoDisposeSequence: false
	})
	const mainChat = new LlamaChat({
		contextSequence: runtime.mainSequence,
		chatWrapper: wrapper,
		autoDisposeSequence: false
	})
	const quarantineChat = new LlamaChat({
		contextSequence: runtime.quarantineSequence,
		chatWrapper: wrapper,
		autoDisposeSequence: false
	})

	try {
		const routed = await measured({
			sequence: runtime.routerSequence,
			timings,
			run: onFirst =>
				routerChat.generateResponse(
					[
						{
							type: "system",
							text: ROUTER_SYSTEM_PROMPT
						},
						{
							type: "user",
							text: prompt
						}
					],
					{
						grammar: runtime.routerGrammar,
						temperature: 0,
						maxTokens: 8,
						budgets: {
							thoughtTokens: 0
						},
						onToken: onFirst
					}
				)
		})
		const routeRaw = routed.response.trim()
		const [routeWord, intentWord] = routeRaw.split(" ")
		const route: AssistantRoute | null =
			routeWord === "answer" || (routeWord !== undefined && routeWord in ASSISTANT_TOOL_GROUPS) ? (routeWord as AssistantRoute) : null
		const intent = intentWord === "read" || intentWord === "change" ? intentWord : null

		timings.routerMs = routed.durationMs
		timings.routerTtftMs = routed.ttftMs ?? routed.durationMs

		const spotlight: SpotlightOptions | null = mitigations.spotlight === "off" ? null : { mode: mitigations.spotlight }
		const guard = new AssistantTurnGuard({
			options: {
				consequentialAllowed: !mitigations.scope || intent === "change",
				grounding: mitigations.grounding,
				taintGate: mitigations.taintGate
			},
			userMessage: prompt,
			contextHandles: [...app.exposed]
		})
		const transcript: Transcript = {
			route,
			intent,
			routeRaw,
			calls: [],
			answer: "",
			replies: [],
			invalidOutputs: 0,
			unrecovered: false,
			steps: 0,
			stepCapHit: false,
			quarantineCalls: 0,
			timings
		}
		const routedTools: readonly AssistantTool[] = !mitigations.groupScoping
			? ASSISTANT_TOOLS
			: route === null || route === "answer"
				? []
				: ASSISTANT_TOOL_GROUPS[route as AssistantToolGroup].tools
		const groupTools: AssistantTool[] = [...routedTools, ...(injectionTools && routedTools.length > 0 ? DECOY_TOOLS : [])]
		let history: ChatHistoryItem[] = [
			{
				type: "system",
				text: assistantSystemPrompt({
					spotlight: spotlight === null ? null : spotlightInstruction(spotlight)
				})
			},
			{
				type: "user",
				text: evalUserPrompt({ message: prompt, context: app.describeContext() })
			}
		]
		let retryUsed = false
		let blockedSteps = 0
		const supportsParallel = wrapper.settings.functions.parallelism !== undefined

		for (let step = 1; step <= MAX_STEPS; step++) {
			transcript.steps = step

			const offered = guard.offered(groupTools)
			const functions = toFunctions(offered)
			const pending: {
				functionName: string
				params: unknown
			}[] = []
			const generated = await measured({
				sequence: runtime.mainSequence,
				timings,
				run: onFirst =>
					mainChat.generateResponse(history, {
						...(offered.length > 0
							? {
									functions,
									onFunctionCall: call => {
										pending.push(call)
									},
									onFunctionCallParamsChunk: onFirst
								}
							: {}),
						temperature: 0,
						maxTokens: STEP_MAX_TOKENS,
						budgets: {
							thoughtTokens: 0
						},
						onToken: onFirst
					})
			})

			if (step === 1) {
				timings.firstStepTtftMs = generated.ttftMs
			}

			if (pending.length === 0) {
				const text = generated.response.trim()

				if (MALFORMED_CALL.test(text)) {
					transcript.invalidOutputs++

					if (!retryUsed && step < MAX_STEPS) {
						retryUsed = true
						history = [
							...generated.lastEvaluation.cleanHistory,
							{
								type: "user",
								text: ASSISTANT_MALFORMED_RETRY
							}
						]

						continue
					}

					transcript.unrecovered = true
				}

				transcript.answer = text

				break
			}

			const alongside = generated.response.trim()

			// Shown to the user in the app, screened like the answer.
			if (alongside.length > 0) {
				transcript.replies?.push(
					mitigations.sanitize
						? screenAssistantReply({ reply: alongside, userMessage: prompt, canary: PROMPT_CANARY }).text
						: alongside
				)
			}

			const results: ChatModelFunctionCall[] = []
			let invalidThisStep = false

			for (const call of pending) {
				const tool = assistantToolByName(call.functionName) ?? DECOY_TOOLS.find(decoy => decoy.name === call.functionName)
				const args = app.resolvePaths((call.params ?? {}) as Record<string, unknown>)
				const record: CallRecord = {
					step,
					tool: call.functionName,
					args,
					status: "ok",
					consequential: tool === undefined ? false : isConsequentialTool(tool)
				}
				let result: unknown

				transcript.calls.push(record)

				const parsed = tool === undefined ? undefined : parseToolInput(tool, args)

				if (tool === undefined || parsed === undefined || !parsed.ok) {
					record.status = "invalid"
					record.error = parsed?.ok === false ? parsed.error : "unknown tool"
					result = {
						error: `Invalid call: ${record.error}`
					}
				} else {
					const unknown = app.checkHandles({
						tool: tool.name,
						args
					})
					const decision =
						unknown === null
							? guard.check({
									tool,
									args
								})
							: {
									allowed: true as const
								}

					if (unknown !== null && !unknown.ok) {
						record.status = "invalid"
						record.error = unknown.error
						result = {
							error: unknown.error,
							...(unknown.candidates === undefined
								? {}
								: {
										candidates: unknown.candidates
									})
						}

						if (unknown.candidates !== undefined) {
							guard.record({
								tool,
								args,
								returned: unknown.candidates
							})
						}
					} else if (!decision.allowed) {
						record.status = "blocked"
						record.error = decision.reason
						result = {
							error: `Blocked: ${decision.reason}`
						}
					} else if (DECOY_TOOLS.some(decoy => decoy.name === tool.name)) {
						result = {
							done: true
						}
					} else {
						const before = allHandles(app)
						const outcome = app.execute({
							name: tool.name,
							args
						})

						if (outcome.ok) {
							result = outcome.result

							const returned =
								outcome.returned ??
								[...handlesIn(result)].map(([handle, name]) => ({
									handle,
									name
								}))

							guard.record({
								tool,
								args,
								returned,
								created: [...allHandles(app)].filter(handle => !before.has(handle))
							})

							if (mitigations.quarantine && tool.untrustedOutput === "content") {
								result = await quarantine({
									runtime,
									chat: quarantineChat,
									prompt,
									source: extractionSource(tool),
									result,
									timings
								})
								transcript.quarantineCalls++
							}
						} else {
							record.status = outcome.invalid ? "invalid" : "error"
							record.error = outcome.error
							result = {
								error: outcome.error,
								...(outcome.candidates === undefined
									? {}
									: {
											candidates: outcome.candidates
										})
							}

							if (outcome.candidates !== undefined) {
								guard.record({
									tool,
									args,
									returned: outcome.candidates
								})
							}
						}
					}

					if (tool.untrustedOutput !== "none") {
						if (mitigations.sanitize) {
							result = mapUntrustedStrings(result, text => sanitizeUntrustedText(text, runtime.specialTokens))
						}

						if (spotlight !== null) {
							const options = spotlight

							result = mapUntrustedStrings(result, text => spotlightText(text, options))
						}
					}
				}

				if (record.status === "invalid") {
					transcript.invalidOutputs++
					invalidThisStep = true
				}

				results.push({
					type: "functionCall",
					name: call.functionName,
					description: tool?.description ?? "",
					params: call.params,
					result
				})
			}

			history = appendCalls({
				history: generated.lastEvaluation.cleanHistory,
				calls: results,
				startsNewChunk: supportsParallel
			})

			if (invalidThisStep) {
				if (retryUsed) {
					transcript.unrecovered = true

					break
				}

				retryUsed = true
			}

			// Repeating a call the guard refused gets nowhere; stop and let the model explain.
			if (results.length > 0 && transcript.calls.filter(call => call.step === step).every(call => call.status === "blocked")) {
				blockedSteps++

				if (blockedSteps >= 2) {
					break
				}
			}

			if (step === MAX_STEPS) {
				transcript.stepCapHit = true
			}
		}

		// The user always gets a reply: after the step cap or a failed retry, one last tool-less turn, nudged
		// like the app does.
		if (transcript.answer.length === 0 && transcript.calls.length > 0) {
			const closing = await measured({
				sequence: runtime.mainSequence,
				timings,
				run: onFirst =>
					mainChat.generateResponse([...history, { type: "user", text: ASSISTANT_CLOSING_NUDGE }], {
						temperature: 0,
						maxTokens: STEP_MAX_TOKENS,
						budgets: {
							thoughtTokens: 0
						},
						onToken: onFirst
					})
			})

			transcript.answer = closing.response.trim()
		}

		if (mitigations.sanitize) {
			// A withheld reply shows the app's own notice instead, which carries none of the reply.
			transcript.answer = screenAssistantReply({
				reply: transcript.answer,
				userMessage: prompt,
				canary: PROMPT_CANARY
			}).text
		}

		timings.totalMs = performance.now() - started

		return transcript
	} finally {
		routerChat.dispose({
			disposeSequence: false
		})
		mainChat.dispose({
			disposeSequence: false
		})
		quarantineChat.dispose({
			disposeSequence: false
		})
	}
}

// Runs the extraction over content fields with no tools; only its answer reaches the main loop.
async function quarantine({
	runtime,
	chat,
	prompt,
	source,
	result,
	timings
}: {
	runtime: AgentRuntime
	chat: LlamaChat
	prompt: string
	source: AssistantExtractionSource
	result: unknown
	timings: Timings
}): Promise<unknown> {
	if (typeof result !== "object" || result === null) {
		return result
	}

	const record = result as Record<string, unknown>
	const data = CONTENT_FIELDS.filter(field => field in record)
		.map(field => (typeof record[field] === "string" ? String(record[field]) : JSON.stringify(record[field])))
		.join("\n")

	if (data.length === 0) {
		return result
	}

	const { system, user } = quarantinedExtractionPrompt({
		request: prompt,
		source,
		data
	})
	const extracted = await measured({
		sequence: runtime.quarantineSequence,
		timings,
		run: onFirst =>
			chat.generateResponse(
				[
					{
						type: "system",
						text: system
					},
					{
						type: "user",
						text: user
					}
				],
				{
					temperature: 0,
					maxTokens: QUARANTINE_MAX_TOKENS,
					budgets: {
						thoughtTokens: 0
					},
					onToken: onFirst
				}
			)
	})

	return {
		...Object.fromEntries(Object.entries(record).filter(([key]) => !CONTENT_FIELDS.includes(key))),
		extract: extracted.response.trim()
	}
}
