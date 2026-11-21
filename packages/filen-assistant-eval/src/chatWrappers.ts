import {
	ChatMLChatWrapper,
	LlamaText,
	resolveChatWrapper,
	SpecialTokensText,
	type ChatModelFunctions,
	type ChatWrapper,
	type ChatWrapperSettings,
	type LlamaModel
} from "node-llama-cpp"
import type { ModelEntry } from "./models"
import { qwen35ChatWrapper } from "@filen/assistant-node"

// LFM2's template lists tools as JSON in the system prompt and the model writes Pythonic calls
// between <|tool_call_start|> and <|tool_call_end|>. node-llama-cpp only constrains JSON params, so
// the call opens with the model's own `[name(` and the grammar takes over at the arguments.
export class Lfm2ChatWrapper extends ChatMLChatWrapper {
	override readonly wrapperName = "LFM2"

	override readonly settings: ChatWrapperSettings = {
		...ChatMLChatWrapper.defaultSettings,
		functions: {
			call: {
				optionalPrefixSpace: true,
				prefix: LlamaText(new SpecialTokensText("<|tool_call_start|>"), "["),
				paramsPrefix: "(",
				suffix: LlamaText(")]", new SpecialTokensText("<|tool_call_end|>")),
				emptyCallParamsPlaceholder: {}
			},
			result: {
				prefix: LlamaText(new SpecialTokensText("<|im_end|>\n<|im_start|>tool\n")),
				suffix: LlamaText(new SpecialTokensText("<|im_end|>\n<|im_start|>assistant\n"))
			}
		}
	}

	override generateAvailableFunctionsSystemText(availableFunctions: ChatModelFunctions): LlamaText {
		const tools = Object.entries(availableFunctions).map(([name, definition]) => ({
			name,
			description: definition.description ?? "",
			parameters: definition.params ?? {
				type: "object",
				properties: {}
			}
		}))

		return tools.length === 0 ? LlamaText([]) : LlamaText(`List of tools: ${JSON.stringify(tools)}`)
	}
}

export function createChatWrapper({ entry, model }: { entry: ModelEntry; model: LlamaModel }): ChatWrapper {
	// The desktop app's own wrapper for Qwen3.5 (non-thinking).
	if (entry.chatWrapper === "qwen3.5") {
		return qwen35ChatWrapper()
	}

	if (entry.chatWrapper === "lfm2") {
		return new Lfm2ChatWrapper()
	}

	const resolved = resolveChatWrapper(model)

	if (resolved === null) {
		throw new Error(`No chat wrapper for ${entry.id}`)
	}

	return resolved
}

// node-llama-cpp tokenizes function results as plain text, but llama.cpp's chat path (llama.rn,
// wllama) renders the template to a string and tokenizes it with special-token parsing, so a
// "<|im_end|>" inside a note becomes a real end-of-turn. With sanitizing off the harness
// reproduces that production behaviour.
export function parseSpecialTokensInResults(wrapper: ChatWrapper): void {
	const original = wrapper.generateFunctionCallResult.bind(wrapper)

	wrapper.generateFunctionCallResult = (functionName: string, functionParams: unknown, result: unknown) =>
		original(functionName, functionParams, result).mapValues(value =>
			typeof value === "string" ? new SpecialTokensText(value) : value
		)
}
