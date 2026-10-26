import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { MessageChannel, type MessagePort } from "node:worker_threads"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { ByteSource } from "../core/opc/index"
import { inThreadPresentationWorker, presentationWorkerPool } from "../dom/presentation/host"
import type { PresentationEvent, SourceSpec } from "../dom/presentation/protocol"
import { installPresentationRealm } from "../dom/presentation/services"
import { CORPUS_DIR } from "./corpusDir"
import { HmtxMeasurer, nodeFontAssets, nodeFontHost } from "./layoutFixtures"
import { CORPUS_PASSWORDS, readCorpusList } from "./oracles/presentation/corpus"

// The Open XML SDK fixture's password (verified with msoffcrypto); the corpus list does not carry it.
const PASSWORDS: Readonly<Record<string, string>> = { ...CORPUS_PASSWORDS, "oxsdk__encrypted_pptx.pptx": "password123" }

// Every OOXML presentation of the frozen corpus opens through a session (the opener, the dispatcher, the client),
// from bytes and from a range port, to its first slide rendered; or it is refused with a typed reason. The
// encrypted ones ask for their password and open with it.

const OOXML = /\.(?:pptx|pptm|potx|potm|ppsx|ppsm)$/iu
const MANIFEST = join(import.meta.dirname, "..", "..", "corpus", "manifest.json")
const files = existsSync(CORPUS_DIR) && existsSync(MANIFEST) ? readCorpusList(MANIFEST).filter(entry => OOXML.test(entry.path)) : []

// The page end of a range port: answers { id, offset, length } with the bytes (as the SDK worker's range server).
function serveRange(bytes: Uint8Array): MessagePort {
	const channel = new MessageChannel()

	channel.port1.on("message", (request: { id: number; offset: number; length: number }) => {
		const slice = bytes.slice(request.offset, request.offset + request.length)

		channel.port1.postMessage({ id: request.id, bytes: slice }, [slice.buffer])
	})
	channel.port1.unref()

	return channel.port2
}

function rangeSource(spec: Extract<SourceSpec, { kind: "range" }>): ByteSource {
	const port = spec.port as unknown as MessagePort
	const waiting = new Map<number, (bytes: Uint8Array) => void>()
	let next = 1

	port.on("message", (answer: { id: number; bytes: Uint8Array }) => {
		waiting.get(answer.id)?.(answer.bytes)
		waiting.delete(answer.id)
	})
	port.unref()

	return {
		size: spec.size,
		read: (offset, length) =>
			new Promise(resolve => {
				const id = next++

				waiting.set(id, resolve)
				port.postMessage({ id, offset, length })
			})
	}
}

type Outcome =
	| { readonly kind: "rendered"; readonly slides: number; readonly layers: number; readonly texts: number; readonly faces: number }
	| { readonly kind: "refused"; readonly reason: string }

async function openThrough(source: SourceSpec, name: string, wrong = false): Promise<Outcome> {
	const pool = presentationWorkerPool(() => inThreadPresentationWorker({ rangeSource }))
	let resolveEvent: (event: PresentationEvent) => void = () => undefined
	const next = (): Promise<PresentationEvent> => new Promise(resolve => (resolveEvent = resolve))
	let pending = next()
	let faces = 0
	const client = pool.open(source, { format: "pptx", fileName: name }, event => {
		if (event.type === "fonts") faces += event.faces.length
		else resolveEvent(event)
	})

	try {
		let event = await pending

		if (event.type === "error" && event.reason === "needsPassword") {
			const password = wrong ? "not the password" : PASSWORDS[name.split("/").pop() ?? ""]

			if (password === undefined) return { kind: "refused", reason: "needsPassword" }

			pending = next()
			client.unlock(password)
			event = await pending
		}

		if (event.type === "error") return { kind: "refused", reason: event.reason }
		if (event.type !== "opened") return { kind: "refused", reason: event.type }

		const first = event.info.slides[0]

		if (first === undefined) return { kind: "rendered", slides: 0, layers: 0, texts: 0, faces }

		const [render] = await client.render([first.ref])

		return {
			kind: "rendered",
			slides: event.info.slides.length,
			layers: render?.layers.length ?? 0,
			texts: render?.layers.filter(layer => layer.text !== undefined).length ?? 0,
			faces
		}
	} finally {
		client.close()
		pool.dispose()
	}
}

describe.skipIf(files.length === 0)("pptx corpus through the session", () => {
	// Text measured as in a worker, with the bundled faces' advances (no browser here); no canvas.
	beforeAll(() => {
		installPresentationRealm({
			text: {
				fontHost: nodeFontHost,
				replayFonts: true,
				fontAssets: nodeFontAssets,
				measurer: new HmtxMeasurer(),
				yield: () => Promise.resolve()
			},
			canvas: {
				canvas: () => undefined,
				decode: () => Promise.resolve(undefined),
				copy: () => Promise.resolve(undefined),
				fontsReady: () => Promise.resolve()
			}
		})
	})
	afterAll(() => installPresentationRealm(undefined))

	it(
		"opens every OOXML presentation to its first slide from bytes and from a range port, or refuses it typed",
		{ timeout: 600_000 },
		async () => {
			const outcomes = new Map<string, Outcome>()
			const ranged = new Map<string, Outcome>()

			for (const entry of files) {
				const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, entry.path)))
				const [fromBytes, fromRange] = [
					await openThrough({ kind: "bytes", bytes: bytes.slice() }, entry.path),
					await openThrough({ kind: "range", port: serveRange(bytes), size: bytes.length, checked: false }, entry.path)
				]

				outcomes.set(entry.path, fromBytes)
				ranged.set(entry.path, fromRange)
			}

			const refusals = [...outcomes].filter(([, outcome]) => outcome.kind === "refused")

			// A range source opens exactly what bytes open.
			expect([...ranged]).toEqual([...outcomes])
			// Every OOXML presentation opens and renders (the encrypted ones with their passwords).
			expect(refusals).toEqual([])
			expect(outcomes.size).toBe(files.length)
			expect(files.length).toBe(205)

			// First slides draw their text through the session's layout (126 first slides hold text of their own; layout and
			// master text adds more), with the faces it registered sent to the page.
			const rendered = [...outcomes.values()].flatMap(outcome => (outcome.kind === "rendered" ? [outcome] : []))

			expect(rendered.filter(outcome => outcome.texts > 0).length).toBeGreaterThanOrEqual(126)
			expect(rendered.filter(outcome => outcome.texts > 0).every(outcome => outcome.faces > 0)).toBe(true)
		}
	)

	it("says a wrong password was wrong", { timeout: 60_000 }, async () => {
		const path = "pptx/tika__testPPT_protected_passtika.pptx"
		const bytes = new Uint8Array(readFileSync(join(CORPUS_DIR, path)))

		expect(await openThrough({ kind: "bytes", bytes }, path, true)).toEqual({ kind: "refused", reason: "wrongPassword" })
	})
})
