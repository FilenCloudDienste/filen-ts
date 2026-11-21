import { type } from "arktype"
import type { AssistantGenerateRequest } from "@filen/shared/assistant"
import type { DesktopAssistantError } from "@filen/shared/desktop"
import type { AssistantModelFiles } from "@filen/shared/dom/assistantModel/manifest"

// The messages between main and the assistant's engine (the "Filen Assistant" utility process running llama.cpp
// through node-llama-cpp). Main validates what the engine sends; the engine takes what main sends as is.

// The node-llama-cpp prebuilt backends the app ships, "cpu" for its `gpu: false`. Not CUDA: its builds need the CUDA
// toolkit's cuBLAS on the system and would add ~300 MiB to each x64 Windows and Linux installer; NVIDIA and AMD GPUs
// run on Vulkan (there is no ROCm build).
export const ENGINE_BACKENDS = ["metal", "vulkan", "cpu"] as const

export type EngineBackend = (typeof ENGINE_BACKENDS)[number]

export type EngineCall =
	| { op: "download"; model: AssistantModelFiles; baseUrl: string; dir: string }
	// `exclude`: backends that crashed this process before; the best of the rest that loads wins.
	| { op: "load"; model: AssistantModelFiles; dir: string; exclude: EngineBackend[]; sequenceTokens: number; primeSystem: string }
	| { op: "generate"; gen: number; request: AssistantGenerateRequest; updates: boolean }
	| { op: "unload" }

export type ToEngine = ({ t: "call"; id: number } & EngineCall) | { t: "cancelDownload" } | { t: "cancel"; gen: number }

const ERRORS = [
	"unavailable",
	"missing",
	"out-of-memory",
	"load-failed",
	"crashed",
	"aborted",
	"network",
	"integrity",
	"storage-full",
	"failed"
] as const satisfies readonly DesktopAssistantError[]

const callId = type("number.integer >= 0")

const resultSchema = type({ ok: "true", value: "unknown", "+": "reject" }).or({
	ok: "false",
	error: type.enumerated(...ERRORS),
	message: "string",
	"+": "reject"
})

const updateSchema = type({ type: "'text'", text: "string", "+": "reject" })
	.or({ type: "'progress'", processed: "number.integer >= 0", total: "number.integer >= 0", "+": "reject" })
	.or({ type: "'call'", index: "number.integer >= 0", name: "string", "+": "reject" })

export const fromEngineSchema = type({ t: "'reply'", id: callId, result: resultSchema, "+": "reject" })
	.or({ t: "'progress'", receivedBytes: "number.integer >= 0", waiting: "boolean", "+": "reject" })
	.or({ t: "'verifying'", "+": "reject" })
	.or({ t: "'trying'", backend: type.enumerated(...ENGINE_BACKENDS), "+": "reject" })
	.or({ t: "'started'", backend: type.enumerated(...ENGINE_BACKENDS), "+": "reject" })
	.or({ t: "'update'", gen: callId, update: updateSchema, "+": "reject" })
	.or({ t: "'log'", level: "'info' | 'warn'", message: "string", "+": "reject" })

// "trying" is sent before a backend's binary is loaded and "started" once it runs: an exit between the two means that
// backend crashed the process; one after "started" happened reading the model (its memory, a driver), which another
// load may not repeat.
export type FromEngine = typeof fromEngineSchema.infer

// The loaded result's shape, checked where main hands it on.
export const loadedSchema = type({
	specialTokens: "string[]",
	backend: type.enumerated(...ENGINE_BACKENDS),
	"promptBatchMs?": "number >= 0",
	"+": "reject"
})

export function failure(error: DesktopAssistantError, message: string): { ok: false; error: DesktopAssistantError; message: string } {
	return { ok: false, error, message }
}
