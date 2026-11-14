import { readFileSync } from "node:fs"
import { MessageChannel } from "node:worker_threads"
import { afterEach, describe, expect, it } from "vitest"
import * as mupdf from "mupdf"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { savePortReader, type SavePortEnd } from "@filen/shared/savePort"
import { PDF_DESKTOP_MEMORY } from "../../core/pdfedit"
import type { RedactionTerm } from "../../core/pdfedit/redactVerify"
import { PDF_AES256_METHOD, PDF_ALLOW_NONE, permissionsValue } from "../../core/pdfedit/security"
import type { PdfEngineClient } from "../../dom/pdfedit/client"
import type { PdfSaveBegun, PdfSaveExpectation } from "../../dom/pdfedit/protocol"
import { createSyncRangeBuffer, type SyncRangePort } from "../../dom/pdfedit/syncRange"
import { makePdf } from "./fixtures"
import { spawnEngine, startEngine, stopEngines } from "./harness"
import { page as toPage, SECRET, SPEC } from "./redactFixtureSpec"
import { signedFixture } from "../pdfSignFixtures"
import { budget } from "../timing"

// The Protect tab through the engine: redaction as commands (marks, apply per page, scrub, sanitize) saved as a full
// rewrite and checked in a second engine before anything is uploaded; protection chosen for the next save, written
// and checked round trip; owner rights unlocked; pages printed with pending marks filled.

afterEach(stopEngines)

const TIMEOUT = budget(60_000)
const SECRET_TERM: RedactionTerm = { text: SECRET, matchCase: false, wholeWord: false }

const fixture = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(`../fixtures/pdfredact/${name}.pdf`, import.meta.url)))

function written(begun: PdfSaveBegun): Extract<PdfSaveBegun, { status: "written" }> {
	if (begun.status !== "written") throw new Error(`refused: ${begun.reason}`)

	return begun
}

// A verifying engine on the editing engine's held output, opened with `password`.
async function verifier(client: PdfEngineClient, size: number, password?: string): Promise<PdfEngineClient> {
	const buffer = createSyncRangeBuffer(8, 64 * 1024)
	const channel = new MessageChannel()

	await client.call("serveOutput", { buffer, port: channel.port1 as unknown as SyncRangePort }, [channel.port1])

	const engine = spawnEngine({})
	const opened = await engine.call(
		"open",
		{
			channel: { buffer, port: channel.port2 as unknown as SyncRangePort, length: size },
			role: "verify",
			...(password === undefined ? {} : { password })
		},
		[channel.port2]
	)

	expect(opened.status).toBe("open")

	return engine
}

async function upload(client: PdfEngineClient): Promise<Uint8Array> {
	const channel = new MessageChannel()
	const reader = savePortReader(channel.port2 as unknown as SavePortEnd)
	const sent = client.call("writeOutput", { port: channel.port1 }, [channel.port1])
	const chunks: Uint8Array[] = []

	for (let chunk = await reader.read(); chunk !== undefined; chunk = await reader.read()) chunks.push(chunk)

	reader.settled(true)
	expect((await sent).uploaded).toBe(true)

	const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
	let at = 0

	for (const chunk of chunks) {
		bytes.set(chunk, at)
		at += chunk.length
	}

	return bytes
}

async function pdfjsText(bytes: Uint8Array, password?: string): Promise<string> {
	const task = pdfjs.getDocument({ data: bytes.slice(), verbosity: 0, ...(password === undefined ? {} : { password }) })
	const document = await task.promise
	let text = ""

	for (let index = 1; index <= document.numPages; index++) {
		const content = await (await document.getPage(index)).getTextContent()

		text += content.items.map(item => ("str" in item ? item.str : "")).join("")
	}

	await task.destroy()

	return text
}

function expectation(begun: Extract<PdfSaveBegun, { status: "written" }>, pageCount: number): PdfSaveExpectation {
	return { pageCount, versions: begun.versions, encryption: begun.encryption, protection: begun.protection }
}

describe("redaction in the engine", () => {
	it(
		"marks, applies per page, scrubs and sanitizes as undoable steps, and saves a file the verifier passes",
		async () => {
			const engine = startEngine(fixture("text"))

			await engine.open()

			const { client } = engine
			const findings = await client.call("redactFind", { query: { terms: [SECRET_TERM], presets: [] } })

			expect(findings.map(finding => finding.page)).toEqual([0, 1])

			const marked = await client.call("dispatch", {
				command: "redact.markFindings",
				args: { findings: findings.map(finding => ({ page: finding.page, quads: finding.quads })) }
			})

			expect(marked.pages).toEqual([0, 1])
			expect(marked.state.changes).toEqual(["content"])

			const area = await client.call("dispatch", { command: "redact.markArea", args: { page: 0, rect: toPage(SPEC.text.lineArea) } })

			expect(area.pages).toEqual([0])

			let marks = await client.call("redactMarks", {})

			expect(marks.map(mark => [mark.page, mark.kind])).toEqual([
				[0, "text"],
				[0, "area"],
				[1, "text"]
			])

			// A mark taken back, and the step undone and redone.
			const areaMark = marks.find(mark => mark.kind === "area")

			if (areaMark === undefined) throw new Error("no area mark")

			await client.call("dispatch", { command: "redact.removeMark", args: { page: 0, id: areaMark.id } })
			expect(await client.call("redactMarks", { pages: [0] })).toHaveLength(1)
			await client.call("undo", {})
			expect(await client.call("redactMarks", { pages: [0] })).toHaveLength(2)
			await client.call("redo", {})
			marks = await client.call("redactMarks", {})
			expect(marks).toHaveLength(2)

			for (const page of [0, 1])
				await client.call("dispatch", {
					command: "redact.apply",
					args: { page, removeAnnotations: true, terms: [SECRET_TERM], sanitize: true }
				})

			await client.call("dispatch", { command: "redact.scrub", args: { terms: [SECRET_TERM] } })
			await client.call("dispatch", { command: "redact.sanitize", args: {} })
			expect(await client.call("redactMarks", {})).toEqual([])

			const begun = written(
				await client.call("saveBegin", { inputBytes: 100_000, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })
			)

			expect(begun).toMatchObject({ versions: 1, encryption: "None", removesContent: true, protection: { kind: "keep" } })
			expect(begun.redaction).toMatchObject({ terms: [SECRET_TERM], sanitized: true, annotationsRemoved: true })
			expect(begun.redaction?.regions.map(region => region.page)).toEqual([0, 1])
			// The words the marks covered, for the structure tree check.
			expect(begun.redaction?.hidden).toContainEqual({ text: SECRET, matchCase: true, wholeWord: true })

			const check = await verifier(client, begun.size)

			expect(await check.call("checkSaved", expectation(begun, 2))).toEqual({ ok: true })
			expect(
				await check.call("verifyRedaction", {
					manifest: begun.redaction ?? { regions: [], terms: [], sanitized: false, annotationsRemoved: true }
				})
			).toEqual({ ok: true })
			check.terminate()

			const bytes = await upload(client)
			const text = await pdfjsText(bytes)

			expect(text).not.toContain(SECRET)
			expect(text).toContain("Agent name:")

			// The redaction became the file: the history starts again on it.
			const ended = await client.call("saveEnd", { outcome: "saved", next: "continue" })

			expect(ended.history).toBe("reset")
			expect(ended.state).toMatchObject({ dirty: false, canUndo: false })
		},
		TIMEOUT
	)

	it(
		"keeps an applied page's regions across undo, redo and a rebuild past a save",
		async () => {
			const engine = startEngine(fixture("text"))

			await engine.open()

			const { client } = engine

			await client.call("dispatch", { command: "redact.markArea", args: { page: 1, rect: [60, 60, 500, 140] } })
			await client.call("dispatch", {
				command: "redact.apply",
				args: { page: 1, removeAnnotations: false, terms: [], sanitize: false }
			})

			// A save written and dropped: the journal cannot undo past it, so undo rebuilds and runs the steps again.
			written(await client.call("saveBegin", { inputBytes: 100_000, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false }))
			await client.call("saveEnd", { outcome: "failed", next: "continue" })
			await client.call("undo", {})
			await client.call("redo", {})

			const begun = written(
				await client.call("saveBegin", { inputBytes: 100_000, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })
			)

			expect(begun.redaction).toMatchObject({ annotationsRemoved: false, sanitized: false })
			expect(begun.redaction?.regions).toEqual([{ page: 1, kind: "area", rect: [60, 60, 500, 140] }])
			await client.call("saveEnd", { outcome: "failed", next: "continue" })
		},
		TIMEOUT
	)

	it(
		"refuses, in the verifier, a file where a searched term survives",
		async () => {
			const engine = startEngine(fixture("text"))

			await engine.open()

			const { client } = engine
			const findings = await client.call("redactFind", { query: { terms: [SECRET_TERM], presets: [] } })

			// Only page 1's finding is marked, yet the term is claimed for the whole file.
			await client.call("dispatch", {
				command: "redact.markFindings",
				args: { findings: findings.filter(finding => finding.page === 0).map(finding => ({ page: 0, quads: finding.quads })) }
			})
			await client.call("dispatch", {
				command: "redact.apply",
				args: { page: 0, removeAnnotations: true, terms: [SECRET_TERM], sanitize: false }
			})
			await client.call("dispatch", { command: "redact.scrub", args: { terms: [SECRET_TERM] } })

			const begun = written(
				await client.call("saveBegin", { inputBytes: 100_000, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })
			)
			const check = await verifier(client, begun.size)
			const verdict = await check.call("verifyRedaction", {
				manifest: begun.redaction ?? { regions: [], terms: [], sanitized: false, annotationsRemoved: true }
			})

			check.terminate()
			expect(verdict).toEqual({ ok: false, failure: { code: "term", term: SECRET, place: "page", page: 2 } })
			await client.call("saveEnd", { outcome: "failed", next: "continue" })
			expect((await client.call("state", {})).dirty).toBe(true)
		},
		TIMEOUT
	)

	it(
		"refuses malformed redaction arguments and the redaction verifier in an editing engine",
		async () => {
			const engine = startEngine(fixture("text"))

			await engine.open()

			const { client } = engine

			for (const args of [
				{ page: 0, rect: [0, 0, 1] },
				{ page: 0, rect: [0, 0, Number.NaN, 4] },
				{ page: 9, rect: [0, 0, 10, 10] },
				{ page: 0, rect: [5, 5, 5.5, 5.5] }
			])
				await expect(client.call("dispatch", { command: "redact.markArea", args })).rejects.toMatchObject({ failure: "badRequest" })

			await expect(
				client.call("dispatch", { command: "redact.scrub", args: { terms: [{ text: " ", matchCase: false, wholeWord: false }] } })
			).rejects.toMatchObject({ failure: "badRequest" })
			await expect(client.call("redactFind", { query: { terms: [], presets: ["everything"] } } as never)).rejects.toMatchObject({
				failure: "badRequest"
			})
			await expect(
				client.call("verifyRedaction", { manifest: { regions: [], terms: [], sanitized: false, annotationsRemoved: true } })
			).rejects.toMatchObject({ failure: "badRequest" })
			expect((await client.call("state", {})).canUndo).toBe(false)
		},
		TIMEOUT
	)

	it(
		"gives the text tool each line's character edges",
		async () => {
			const engine = startEngine(fixture("text"))

			await engine.open()

			const lines = await engine.client.call("textGeometry", { page: 0 })
			const first = lines[0]

			expect(first?.edges.length).toBe(SPEC.text.line1.text.length + 1)
			expect(first?.edges.every((edge, index, all) => index === 0 || edge >= (all[index - 1] ?? 0))).toBe(true)
			expect(first?.rect[0]).toBeCloseTo(SPEC.text.line1.x, 0)
		},
		TIMEOUT
	)

	it(
		"prints a page with its pending marks filled, without changing it",
		async () => {
			const engine = startEngine(fixture("text"))

			await engine.open()

			const { client } = engine
			// The middle of the first line, in page space at scale 1.
			const [x0, y0, x1, y1] = toPage([200, 695, 260, 715])

			await client.call("dispatch", { command: "redact.markArea", args: { page: 0, rect: [x0, y0, x1, y1] } })

			const pixel = async (print: boolean): Promise<readonly number[]> => {
				const tile = [
					Math.round((x0 + x1) / 2),
					Math.round((y0 + y1) / 2),
					Math.round((x0 + x1) / 2) + 1,
					Math.round((y0 + y1) / 2) + 1
				] as const
				const drawn = await client.call("render", {
					page: 0,
					scale: 1,
					rotation: 0,
					tile,
					priority: "visible",
					...(print ? { print: { annotations: false } } : {})
				})
				const rgba = (drawn.bitmap as unknown as { rgba: Uint8ClampedArray }).rgba

				return [...rgba.subarray(0, 3)]
			}

			expect(await pixel(true)).toEqual([0, 0, 0])
			expect(await pixel(false)).not.toEqual([0, 0, 0])
			expect((await client.call("redactMarks", {})).length).toBe(1)
		},
		TIMEOUT
	)
})

describe("protection in the engine", () => {
	it.each(["pässwörd", 'x","encrypt":"none', "a,owner-password=b"])(
		"writes a new password to open (%j) in the save, checks it round trip and restarts on the file",
		async password => {
			const engine = startEngine(makePdf({ pages: 2 }))

			await engine.open()

			const { client } = engine
			const chosen = await client.call("securitySet", { choice: { kind: "open", password } })

			expect(chosen).toMatchObject({ ok: true, state: { dirty: true, security: { method: "none", pending: "open" } } })

			const begun = written(
				await client.call("saveBegin", { inputBytes: 10_000, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })
			)

			expect(begun).toMatchObject({
				encryption: PDF_AES256_METHOD,
				removesContent: false,
				redaction: null,
				protection: { kind: "new" }
			})

			if (begun.protection.kind !== "new") throw new Error("no new protection")

			const check = await verifier(client, begun.size, begun.protection.ownerPassword)

			expect(await check.call("checkSaved", expectation(begun, 2))).toEqual({ ok: true })
			check.terminate()

			const bytes = await upload(client)

			expect(await pdfjsText(bytes, password)).toContain("Page 1")
			await expect(pdfjsText(bytes)).rejects.toMatchObject({ name: "PasswordException" })

			const ended = await client.call("saveEnd", { outcome: "saved", next: "continue" })

			expect(ended.history).toBe("reset")
			expect(ended.state).toMatchObject({
				dirty: false,
				encryption: { method: PDF_AES256_METHOD, access: "owner" },
				security: { method: "aes-256", openPassword: true, ownerAccess: true, pending: null }
			})
			// The session goes on on the protected file: the next save keeps the protection.
			const again = written(
				await client.call("saveBegin", { inputBytes: bytes.length, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })
			)

			expect(again).toMatchObject({ encryption: PDF_AES256_METHOD, protection: { kind: "keep" } })
			await client.call("saveEnd", { outcome: "failed", next: "continue" })
		},
		TIMEOUT
	)

	it(
		"unlocks an owner-restricted file, honours its restrictions until then, and removes the protection",
		async () => {
			const source = new mupdf.PDFDocument(makePdf({ pages: 1 }))
			const restricted = source
				.saveToBuffer({
					encrypt: "aes-256",
					"user-password": "",
					"owner-password": "owner,pw",
					permissions: permissionsValue(PDF_ALLOW_NONE)
				})
				.asUint8Array()
				.slice()

			source.destroy()

			const engine = startEngine(restricted)

			await engine.open()

			const { client } = engine
			const state = await client.call("state", {})

			expect(state.tools).toMatchObject({ content: "restricted", annotate: "restricted", security: "restricted" })
			expect(state.security).toMatchObject({ restricted: true, ownerAccess: false })
			expect(await client.call("securitySet", { choice: { kind: "remove" } })).toEqual({ ok: false, reason: "ownerRequired" })
			await expect(client.call("dispatch", { command: "redact.markPage", args: { page: 0 } })).rejects.toMatchObject({
				failure: "notAllowed"
			})

			// A wrong password leaves the document as it was (still readable).
			expect(await client.call("securityUnlock", { password: "owner" })).toEqual({ ok: false })
			expect((await client.call("text", { page: 0 })).lines.length).toBeGreaterThan(0)

			const unlocked = await client.call("securityUnlock", { password: "owner,pw" })

			expect(unlocked).toMatchObject({ ok: true, state: { tools: { content: null }, restrictions: { owner: true } } })
			expect(await client.call("securitySet", { choice: { kind: "remove" } })).toMatchObject({ ok: true, state: { dirty: true } })

			const begun = written(
				await client.call("saveBegin", { inputBytes: restricted.length, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })
			)

			expect(begun).toMatchObject({ encryption: "None", protection: { kind: "none" } })

			const check = await verifier(client, begun.size)

			expect(await check.call("checkSaved", expectation(begun, 1))).toEqual({ ok: true })
			check.terminate()

			// The owner password given at open lifts the restrictions of a file that opens without a password.
			const withOwner = startEngine(restricted)

			expect(await withOwner.open("owner,pw")).toMatchObject({ status: "open", access: "owner" })
			expect(await withOwner.client.call("state", {})).toMatchObject({
				tools: { content: null },
				security: { ownerAccess: true, openPassword: false }
			})

			const bytes = await upload(client)
			const reopened = mupdf.Document.openDocument(bytes, "application/pdf")

			expect(reopened.needsPassword()).toBe(false)
			expect(reopened.getMetaData("encryption")).toBe("None")
			await client.call("saveEnd", { outcome: "saved", next: "continue" })
		},
		TIMEOUT
	)

	it(
		"upgrades an RC4 file to AES-256 with the same passwords and permissions",
		async () => {
			const source = new mupdf.PDFDocument(makePdf({ pages: 1 }))
			const permissions = permissionsValue({ print: true, copy: false, change: false })
			const rc4 = source
				.saveToBuffer({ encrypt: "rc4-128", "user-password": "both", "owner-password": "both", permissions })
				.asUint8Array()
				.slice()

			source.destroy()

			const engine = startEngine(rc4)

			await engine.open("both")

			const { client } = engine
			const state = await client.call("state", {})

			expect(state.security).toMatchObject({ rc4: true, upgrade: null })

			expect(await client.call("securitySet", { choice: { kind: "upgrade" } })).toMatchObject({ ok: true })

			const begun = written(
				await client.call("saveBegin", { inputBytes: rc4.length, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: false })
			)

			expect(begun.protection).toEqual({ kind: "new", userPassword: "both", ownerPassword: "both", permissions })

			const check = await verifier(client, begun.size, "both")

			expect(await check.call("checkSaved", expectation(begun, 1))).toEqual({ ok: true })
			check.terminate()

			await client.call("saveEnd", { outcome: "failed", next: "continue" })
		},
		TIMEOUT
	)

	it(
		"asks before new protection invalidates a signature, then rewrites the file",
		async () => {
			const source = signedFixture("approval-rsa.pdf")
			const engine = startEngine(source)

			await engine.open()

			const { client } = engine

			expect(await client.call("securitySet", { choice: { kind: "open", password: "pw" } })).toMatchObject({ ok: true })

			const refused = await client.call("saveBegin", {
				inputBytes: source.length,
				memory: PDF_DESKTOP_MEMORY,
				invalidateConfirmed: false
			})

			expect(refused).toMatchObject({ status: "refused", reason: "invalidatesSignatures" })

			const begun = written(
				await client.call("saveBegin", { inputBytes: source.length, memory: PDF_DESKTOP_MEMORY, invalidateConfirmed: true })
			)

			expect(begun).toMatchObject({ versions: 1, plan: { mode: "full" }, protection: { kind: "new" } })
			await client.call("saveEnd", { outcome: "failed", next: "continue" })
		},
		TIMEOUT
	)

	it(
		"refuses a malformed protection choice",
		async () => {
			const engine = startEngine(makePdf({ pages: 1 }))

			await engine.open()

			for (const choice of [
				{ kind: "open" },
				{ kind: "restrict", ownerPassword: "o", openPassword: 3, allowed: PDF_ALLOW_NONE },
				{ kind: "rc4" }
			])
				await expect(engine.client.call("securitySet", { choice } as never)).rejects.toMatchObject({ failure: "badRequest" })

			expect(await engine.client.call("securitySet", { choice: { kind: "open", password: "a\tb" } })).toEqual({
				ok: false,
				reason: "passwordRefused"
			})
		},
		TIMEOUT
	)
})
