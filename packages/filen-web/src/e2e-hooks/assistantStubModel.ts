import {
	AssistantAbortError,
	type AssistantGenerateRequest,
	type AssistantGenerateResult,
	type AssistantModel,
	type AssistantModelToolCall
} from "@filen/shared/assistant"

// A scripted model for the e2e suite: the real 2.7 GB model cannot run on CI. Everything around the model is the
// real thing (the shared loop, the guard, the web executor and its tool adapters, the confirmation cards, the
// selection transform and the formula helper); only `generate` answers from the script a spec set. Installed only in
// VITE_E2E builds (e2e-hooks), so nothing here ships.
//
// Plain JSON, so it crosses the Playwright bridge. Each generate request is answered by its kind:
//   - router: `route` ("drive read", "organize change", … or "answer", the default);
//   - main step with tools: the next entry of `steps` (its calls), then a step with no call;
//   - closing reply, or a main step once `steps` ran out: `reply`;
//   - act-on-read draft: `draft`;
//   - content extraction (a read file, note, chat or document, and its chunk combine): `extract`;
//   - selection transform: `transform`;
//   - spreadsheet formula: `formula`;
//   - speaker notes drafted from a slide: `notes`;
//   - PDF form fill: `form`, the value for each field by its label (the stub answers "N: value" for the fields the
//     request numbers with those labels, so a spec need not know the page's tab order).
// A string argument "{{handle:NAME}}" becomes the handle the request shows for an item named NAME (a listing row,
// the screen context line, by name or as a path's last part, or a single-item result), as the model would copy it.
export interface AssistantStubScript {
	route?: string
	steps?: readonly (readonly { name: string; args: Record<string, unknown> }[])[]
	reply?: string
	draft?: string
	extract?: string
	transform?: string
	formula?: string
	notes?: string
	form?: Record<string, string>
}

export type AssistantStubRequestKind = "router" | "step" | "reply" | "draft" | "extract" | "transform" | "formula" | "notes" | "form"

// What the stub was asked, for specs to assert on: what a tool returned reaches the next step's messages.
export interface AssistantStubRequest {
	kind: AssistantStubRequestKind
	tools: string[]
	// The request's last message, cut to MESSAGE_LOG_CHARS.
	last: string
}

const MESSAGE_LOG_CHARS = 4000
const REQUEST_LOG_CAP = 200

let script: AssistantStubScript = {}
let stepIndex = 0
let callCount = 0
const requests: AssistantStubRequest[] = []

function kindOf(request: AssistantGenerateRequest): AssistantStubRequestKind {
	const system = request.messages[0]?.role === "system" ? request.messages[0].content : ""

	switch (request.slot) {
		case "router":
			return "router"
		case "extraction":
			if (system.startsWith("You fill in a form")) {
				return "form"
			}

			if (request.grammar !== undefined) {
				return "formula"
			}

			if (system.startsWith("Write short speaker notes")) {
				return "notes"
			}

			return system.startsWith("You edit text the user selected.") ? "transform" : "extract"
		case "main":
			if (system.startsWith("Write a reply the user can send in a chat")) {
				return "draft"
			}

			return request.tools === undefined || request.tools.length === 0 || request.toolChoice === "none" ? "reply" : "step"
	}
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// The handle shown for `name` anywhere in the request, latest mention first.
function handleFor(request: AssistantGenerateRequest, name: string): string | undefined {
	const raw = escapeRegExp(name)
	const quoted = escapeRegExp(JSON.stringify(name))
	const patterns = [
		new RegExp(`\\b([a-z]\\d+) ⟦${raw}⟧`, "g"),
		new RegExp(`${quoted} \\(handle ([a-z]\\d+)\\)`, "g"),
		// The context line names the open directory by its path ("/Documents/Invoices").
		new RegExp(`"/(?:[^"]*/)?${escapeRegExp(JSON.stringify(name).slice(1))} \\(handle ([a-z]\\d+)\\)`, "g"),
		new RegExp(`"handle":"([a-z]\\d+)","(?:name|title)":${quoted}`, "g")
	]

	for (const message of [...request.messages].reverse()) {
		for (const pattern of patterns) {
			const match = [...message.content.matchAll(pattern)].at(-1)

			if (match?.[1] !== undefined) {
				return match[1]
			}
		}
	}

	return undefined
}

function resolveArgs(request: AssistantGenerateRequest, value: unknown): unknown {
	if (typeof value === "string") {
		const handle = /^\{\{handle:(.+)\}\}$/.exec(value)

		if (handle?.[1] === undefined) {
			return value
		}

		const found = handleFor(request, handle[1])

		if (found === undefined) {
			console.error(`[e2e assistant stub] no handle shown for "${handle[1]}"`)

			return value
		}

		return found
	}

	if (Array.isArray(value)) {
		return value.map(item => resolveArgs(request, item))
	}

	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveArgs(request, item)]))
	}

	return value
}

// "N: value" lines for the fields the request numbers ("N. kind ⟦label⟧…") whose label the script gives a value.
function formAnswer(request: AssistantGenerateRequest, values: Readonly<Record<string, string>>): string {
	const user = request.messages.at(-1)?.content ?? ""

	return [...user.matchAll(/^(\d+)\. \w+ ⟦([^⟧]*)⟧/gmu)]
		.flatMap(([, index, label]) => {
			const value = label === undefined ? undefined : values[label]

			return index === undefined || value === undefined ? [] : [`${index}: ${value}\n`]
		})
		.join("")
}

function answer(request: AssistantGenerateRequest, kind: AssistantStubRequestKind): AssistantGenerateResult {
	const text = (content: string | undefined, fallback: string): AssistantGenerateResult => ({
		content: content ?? fallback,
		toolCalls: []
	})

	switch (kind) {
		case "router":
			return text(script.route, "answer")
		case "draft":
			return text(script.draft, "Thanks, sounds good.")
		case "extract":
			return text(script.extract, "The content holds no details for this request.")
		case "transform":
			return text(script.transform, "")
		case "formula":
			return text(script.formula, "=1")
		case "notes":
			return text(script.notes, "")
		case "form":
			return text(formAnswer(request, script.form ?? {}), "")
		case "reply":
			return text(script.reply, "Done.")
		case "step": {
			const calls = script.steps?.[stepIndex]

			if (calls === undefined) {
				return text(script.reply, "Done.")
			}

			stepIndex++

			const toolCalls: AssistantModelToolCall[] = calls.map(call => ({
				id: `stub_${String(++callCount)}`,
				name: call.name,
				arguments: JSON.stringify(resolveArgs(request, call.args))
			}))

			return { content: "", toolCalls }
		}
	}
}

export const assistantStubGenerate: AssistantModel["generate"] = (request, { signal, onText, onToolCall }) => {
	if (signal.aborted) {
		return Promise.reject(new AssistantAbortError())
	}

	const kind = kindOf(request)

	requests.push({
		kind,
		tools: (request.tools ?? []).map(tool => tool.name),
		last: (request.messages.at(-1)?.content ?? "").slice(0, MESSAGE_LOG_CHARS)
	})
	requests.splice(0, Math.max(0, requests.length - REQUEST_LOG_CAP))

	const result = answer(request, kind)

	result.toolCalls.forEach((call, index) => {
		onToolCall?.({ index, name: call.name })
	})

	if (result.content.length > 0) {
		onText?.(result.content)
	}

	// A macrotask, so the UI sees each phase as the real engine's would.
	return new Promise(resolve => {
		setTimeout(() => {
			resolve(result)
		}, 0)
	})
}

// Sets the script the next requests answer from and restarts its steps.
export function loadAssistantStubScript(next: AssistantStubScript): void {
	script = next
	stepIndex = 0
}

export function assistantStubRequests(): AssistantStubRequest[] {
	return requests.map(request => ({ ...request, tools: [...request.tools] }))
}
