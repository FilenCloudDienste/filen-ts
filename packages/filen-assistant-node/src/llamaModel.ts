import type {
	AssistantChatMessage,
	AssistantGenerateRequest,
	AssistantGenerateResult,
	AssistantModelToolCall,
	AssistantSignal
} from "@filen/shared/assistant"
import {
	LlamaChat,
	LlamaText,
	QwenChatWrapper,
	resolveChatWrapper,
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

// The AssistantModel requests over node-llama-cpp: one context sequence per slot (router, main loop, extraction),
// so no kind of request pushes another's cached prompt out. The desktop app's engine runs it and the eval harness
// measures it: history, the call opener of a required call, calls written back as text when none may be made.

export type Slot = AssistantGenerateRequest["slot"]

export type GenerateUpdate = { type: "text"; text: string } | { type: "call"; index: number; name: string }

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text) as unknown
	} catch {
		return text
	}
}

// The loop's engine-neutral messages as node-llama-cpp's chat history: a tool result goes onto the call it answers,
// inside the model turn that made it.
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

// Non-thinking mode: the small Qwen3.5 models loop when allowed to think.
export function qwen35ChatWrapper(): ChatWrapper {
	return new QwenChatWrapper({ variation: "3.5", thoughts: "discourage" })
}

// The shipped models are Qwen3.5; anything else gets the wrapper node-llama-cpp resolves from its template.
export function chatWrapperFor(model: LlamaModel): ChatWrapper {
	const architecture = model.fileInfo.metadata.general.architecture as string

	if (architecture.startsWith("qwen35")) {
		return qwen35ChatWrapper()
	}

	const resolved = resolveChatWrapper(model)

	if (resolved === null) {
		throw new Error(`No chat wrapper for a ${architecture} model`)
	}

	return resolved
}

// A request that must call opens the reply with the template's call opener, so the model writes the call in the
// tokens it would have chosen ("=list" is one token; an injected "<function=" would split it).
const OPENER_LOGIT = 100

function openerBias(model: LlamaModel, wrapper: ChatWrapper): TokenBias {
	const opener = LlamaText(wrapper.settings.functions.call.prefix).tokenize(model.tokenizer, "trimLeadingSpace")[0]

	if (opener === undefined || model.detokenize([opener], true).length < 2) {
		throw new Error(`${wrapper.wrapperName} opens calls without a token of their own; a required call needs its own handling`)
	}

	return new TokenBias(model.tokenizer).set(opener, { logit: OPENER_LOGIT })
}

export class LlamaSlotModel {
	readonly wrapper: ChatWrapper
	private readonly llama: Llama
	private readonly model: LlamaModel
	private readonly chats: Record<Slot, LlamaChat>
	private opener: TokenBias | undefined
	private readonly grammars = new Map<string, Promise<LlamaGrammar>>()
	private generations = 0

	// `wrapper`: the model's chat wrapper when not the one chatWrapperFor picks (the eval names one per model).
	constructor({ llama, sequences, wrapper }: { llama: Llama; sequences: Record<Slot, LlamaContextSequence>; wrapper?: ChatWrapper }) {
		this.llama = llama
		this.model = sequences.main.model
		this.wrapper = wrapper ?? chatWrapperFor(this.model)

		const chat = (contextSequence: LlamaContextSequence) =>
			new LlamaChat({ contextSequence, chatWrapper: this.wrapper, autoDisposeSequence: false })

		this.chats = { router: chat(sequences.router), main: chat(sequences.main), extraction: chat(sequences.extraction) }
	}

	sequence(slot: Slot): LlamaContextSequence {
		return this.chats[slot].sequence
	}

	dispose(): void {
		for (const chat of Object.values(this.chats)) {
			chat.dispose({ disposeSequence: false })
		}
	}

	private grammar(source: string): Promise<LlamaGrammar> {
		let grammar = this.grammars.get(source)

		if (grammar === undefined) {
			grammar = this.llama.createGrammar({ grammar: source })
			this.grammars.set(source, grammar)
		}

		return grammar
	}

	async generate(
		request: AssistantGenerateRequest,
		{
			signal,
			onUpdate,
			onFirstToken
		}: {
			signal: AssistantSignal
			onUpdate?: (update: GenerateUpdate) => void
			// Each token generated, text or call: the first call marks the first token.
			onFirstToken?: () => void
		}
	): Promise<AssistantGenerateResult> {
		const functions: ChatModelFunctions | undefined =
			request.tools === undefined || request.tools.length === 0
				? undefined
				: Object.fromEntries(request.tools.map(tool => [tool.name, { description: tool.description, params: tool.parameters }]))
		const chat = this.chats[request.slot]
		// Only the first token is the opener's; the rest is sampled as usual.
		let opening =
			request.toolChoice === "required" && functions !== undefined
				? (this.opener ??= openerBias(this.model, this.wrapper))
				: undefined
		const unbiased = new TokenBias(this.model.tokenizer)
		const grammar = request.grammar === undefined ? undefined : await this.grammar(request.grammar)
		const named = new Set<number>()
		let text = ""
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
			onToken: () => {
				onFirstToken?.()
			},
			onTextChunk: (chunk: string) => {
				text += chunk
				onUpdate?.({ type: "text", text })
			}
		}
		const response =
			grammar !== undefined
				? await chat.generateResponse(history, { ...common, grammar })
				: functions !== undefined
					? await chat.generateResponse(history, {
							...common,
							functions,
							onFunctionCallParamsChunk: chunk => {
								onFirstToken?.()

								if (!named.has(chunk.callIndex)) {
									named.add(chunk.callIndex)
									onUpdate?.({ type: "call", index: chunk.callIndex, name: chunk.functionName })
								}
							}
						})
					: await chat.generateResponse(history, common)

		this.generations++

		// A request that may call nothing (toolChoice "none") gets its calls back as text, as an engine that parses no
		// calls hands them back; the loop drops call syntax from it.
		const parsed = response.functionCalls ?? []
		const none = request.toolChoice === "none"
		const written = none
			? parsed
					.map(call => `<tool_call>\n${JSON.stringify({ name: call.functionName, arguments: call.params ?? {} })}\n</tool_call>`)
					.join("\n")
			: ""
		const toolCalls: AssistantModelToolCall[] = (none ? [] : parsed).map((call, index) => ({
			id: `nl_${String(this.generations)}_${String(index)}`,
			name: call.functionName,
			arguments: JSON.stringify(call.params ?? {})
		}))

		return {
			content: written.length === 0 ? response.response : `${response.response}\n${written}`.trim(),
			toolCalls,
			...(response.metadata.stopReason === "maxTokens" ? { truncated: true } : {})
		}
	}
}
