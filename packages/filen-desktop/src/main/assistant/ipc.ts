import { type } from "arktype"
import type { AssistantGenerateRequest } from "@filen/shared/assistant"
import { isAllowedModelOrigin, parseModelFiles } from "@filen/shared/dom/assistantModel/manifest"
import { type AssistantCall, assistantChannel } from "../../shared/channels.ts"
import { type CheckedCall, checkedCalls, type IpcMain, registerCalls } from "../pages.ts"
import type { AssistantService } from "./service.ts"

// Every assistant request answers the app's own top-level document only, with its arguments checked before the
// service sees them. The page names model files only by the manifest's published names, never a path; main picks the
// directory.

// What one request may carry (1 MiB a text): the shared loop's prompts stay far below these (8192 tokens of context).
const content = "string <= 1048576"
const MESSAGES_MAX = 512
const TOOLS_MAX = 128

const toolCallSchema = type({ id: "string <= 256", name: "string <= 256", arguments: content, "+": "reject" })

const messageSchema = type({ role: "'system' | 'user'", content, "+": "reject" })
	.or({ role: "'assistant'", content, "toolCalls?": toolCallSchema.array().atMostLength(TOOLS_MAX), "+": "reject" })
	.or({ role: "'tool'", content, toolCallId: "string <= 256", "+": "reject" })

const toolSchema = type({
	name: "string <= 256",
	description: content,
	// A portable JSON schema; node-llama-cpp turns it into the call's grammar.
	parameters: type({ type: "'object'" }),
	"+": "reject"
})

const requestSchema = type({
	messages: messageSchema.array().moreThanLength(0).atMostLength(MESSAGES_MAX),
	"tools?": toolSchema.array().atMostLength(TOOLS_MAX),
	"grammar?": content,
	"toolChoice?": "'none' | 'required'",
	slot: "'router' | 'main' | 'extraction'",
	maxTokens: "1 <= number.integer <= 32768",
	"+": "reject"
})

// A chunk of an imported shard; the page sends 8 MiB.
const IMPORT_CHUNK_MAX = 16 * 1024 * 1024

const genSchema = type("0 <= number.integer <= 9007199254740991")

const idSchema = type(/^\w[\w.-]*$/)

const loadOptionsSchema = type({
	sequenceTokens: "256 <= number.integer <= 131072",
	primeSystem: content,
	"+": "reject"
})

// The manifest's files, or a refusal the page sees as an invalid payload.
function modelFiles(value: unknown): ReturnType<typeof parseModelFiles> {
	try {
		return parseModelFiles(value)
	} catch {
		throw new Error("invalid assistant payload")
	}
}

function modelBaseUrl(value: string): string {
	let url: URL

	try {
		url = new URL(value)
	} catch {
		throw new Error("invalid assistant payload")
	}

	if (!isAllowedModelOrigin(url)) {
		throw new Error("invalid assistant payload")
	}

	return url.href
}

const call = checkedCalls<AssistantService>("assistant")

const CALLS: Record<AssistantCall, CheckedCall<AssistantService>> = {
	available: call(type([]), service => service.available()),
	inspect: call(type(["object"]), (service, _page, [model]) => service.inspect(modelFiles(model))),
	otherModels: call(type([idSchema]), (service, _page, [id]) => service.otherModels(id)),
	deleteModels: call(type([idSchema.or("null")]), (service, _page, [keep]) => service.deleteModels(keep)),
	download: call(type(["object", "string <= 2048"]), (service, page, [model, baseUrl]) =>
		service.download(page, modelFiles(model), modelBaseUrl(baseUrl))
	),
	cancelDownload: call(type([]), (service, page) => {
		service.cancelDownload(page)
	}),
	importChunk: call(
		type([
			"object",
			"string <= 256",
			"0 <= number.integer <= 9007199254740991",
			type.instanceOf(Uint8Array).narrow((bytes, ctx) => bytes.byteLength <= IMPORT_CHUNK_MAX || ctx.mustBe("at most 16 MiB")),
			"boolean"
		]),
		(service, page, [model, file, offset, bytes, last]) => service.importChunk(page, modelFiles(model), file, offset, bytes, last)
	),
	load: call(type(["object", loadOptionsSchema]), (service, page, [model, options]) => service.load(page, modelFiles(model), options)),
	generate: call(type([genSchema, requestSchema, "boolean"]), (service, page, [gen, request, updates]) =>
		// The tools' parameters are checked as objects; node-llama-cpp reads them as the JSON schemas they are.
		service.generate(page, gen, request as unknown as AssistantGenerateRequest, updates)
	),
	cancel: call(type([genSchema]), (service, page, [gen]) => {
		service.cancel(page, gen)
	}),
	unload: call(type([]), (service, page) => service.unload(page)),
	release: call(type([]), (service, page) => {
		service.release(page)
	})
}

export function registerAssistantIpc(ipc: IpcMain, service: AssistantService, trusted: (senderUrl: string | undefined) => boolean): void {
	registerCalls(ipc, CALLS, assistantChannel, service, trusted)
}
