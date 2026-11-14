import { describe, expect, it, vi } from "vitest"
import { PDF_DESKTOP_MEMORY, type PdfEditState } from "@filen/office/core/pdfedit"
import type { RedactionFinding, RedactionManifest, RedactionMark } from "@filen/office/core/pdfedit/redactVerify"
import type { PdfSaveBegun } from "@filen/office/dom/pdfedit"
import type { PdfEditSessionModel } from "@filen/office/react/pdfedit"
import type { DriveItem } from "@/features/drive/lib/item"
import { SaveRefusedError } from "@/features/drive/lib/previewSave.logic"
import type { PdfEngine } from "@/features/pdf/session/engineWorker"

// The Protect wiring on the page's side: a save checks the written file's protection round trip and its redaction in
// the verifying engine before anything is uploaded (a failed redaction check says what remained), asks before
// invalidating signatures, and after a new version says where the file's password and earlier versions stand. Marks
// that still cover a search's findings decide which terms the verifier must find nowhere.

const { savePdfVersion, savePdfCopy, PdfRedactionRefusedError } = await import("@/features/pdf/save/pdfSave")
const { isRedactionRefusal, markedFindings, markedPages } = await import("@/features/pdf/redact/redaction.logic")
const { redactionRects } = await import("@/features/pdf/print/pdfPrint")
const { refusalKey } = await import("@/features/pdf/security/protectSession")
const { ownerRestricted } = await import("@/features/pdf/security/protectNotices")

const STATE = {
	revision: 1,
	pageCount: 2,
	dirty: true,
	encryption: { method: "None", access: "none" },
	restrictions: { owner: true }
} as unknown as PdfEditState

const MANIFEST: RedactionManifest = { regions: [], terms: [], sanitized: true, annotationsRemoved: true }

const ITEM = { type: "file", data: { uuid: "u", size: 1000n, timestamp: 0n, decryptedMeta: { created: 0n } } } as unknown as DriveItem

interface Calls {
	readonly edit: { op: string; args: unknown }[]
	readonly verify: { op: string; args: unknown }[]
	readonly verifierPasswords: (string | undefined)[]
}

function written(overrides: Partial<Extract<PdfSaveBegun, { status: "written" }>> = {}): PdfSaveBegun {
	return {
		status: "written",
		plan: { mode: "full", encryption: "keep", invalidates: [], peakBytes: 1, options: "", refuse: null },
		size: 10,
		versions: 1,
		encryption: "None",
		redaction: null,
		removesContent: false,
		protection: { kind: "keep" },
		...overrides
	}
}

function deps(begun: PdfSaveBegun[], verdict: unknown, calls: Calls, extra: Record<string, unknown> = {}) {
	const editCall = (op: string, args: unknown): Promise<unknown> => {
		calls.edit.push({ op, args })

		switch (op) {
			case "saveBegin":
				return Promise.resolve(begun.shift())
			case "saveEnd":
				return Promise.resolve({ state: STATE, heapBytes: 0, history: "reset" })
			case "writeOutput":
				return Promise.resolve({ uploaded: true })
			default:
				return Promise.resolve(null)
		}
	}
	const verifier = {
		client: {
			call: (op: string, args: unknown) => {
				calls.verify.push({ op, args })

				return Promise.resolve(op === "checkSaved" ? { ok: true } : verdict)
			}
		},
		close: () => Promise.resolve({ heapBytes: 0 })
	}

	return {
		engine: {
			client: { call: editCall },
			opened: { status: "open" },
			close: () => Promise.resolve({ heapBytes: 0 })
		} as unknown as PdfEngine,
		session: { getSnapshot: () => ({ state: STATE }), saved: vi.fn() } as unknown as PdfEditSessionModel,
		memory: PDF_DESKTOP_MEMORY,
		fileBytes: 1000,
		password: "old",
		openVerifier: (_channel: unknown, password: string | undefined) => {
			calls.verifierPasswords.push(password)

			return Promise.resolve(verifier as unknown as PdfEngine)
		},
		versioning: () => true,
		hold: () => () => undefined,
		needsRespawn: () => false,
		respawn: () => Promise.resolve(true),
		onHistoryReset: vi.fn(),
		...extra
	}
}

function calls(): Calls {
	return { edit: [], verify: [], verifierPasswords: [] }
}

describe("saving a redacted or protected PDF", () => {
	it("refuses a file that fails the redaction check, uploading nothing, and says what remained", async () => {
		const seen = calls()
		const failure = { code: "term", term: "Secret", place: "page", page: 2 } as const
		const save = savePdfCopy(deps([written({ redaction: MANIFEST, removesContent: true })], { ok: false, failure }, seen), () =>
			Promise.resolve(null)
		)

		await expect(save).rejects.toBeInstanceOf(PdfRedactionRefusedError)
		await expect(save).rejects.toMatchObject({ failure })
		expect(seen.verify.map(entry => entry.op)).toEqual(["checkSaved", "verifyRedaction"])
		expect(seen.verify[1]?.args).toEqual({ manifest: MANIFEST })
		expect(seen.edit.map(entry => entry.op)).not.toContain("writeOutput")
		expect(seen.edit.at(-1)).toEqual({ op: "saveEnd", args: { outcome: "failed", next: "continue" } })
	})

	it("checks new protection round trip, opening the written file with its owner password", async () => {
		const seen = calls()
		const protection = { kind: "new", userPassword: "u", ownerPassword: "o", permissions: -4 } as const
		const onProtected = vi.fn()
		const edits = await savePdfVersion(
			deps([written({ protection, encryption: "Standard V5 R6 256-bit AES" })], { ok: true }, seen, { onProtected }),
			ITEM
		)

		expect(seen.verifierPasswords).toEqual(["o"])
		expect(seen.verify[0]?.args).toMatchObject({ encryption: "Standard V5 R6 256-bit AES", protection })

		await edits.commit(ITEM)
		expect(onProtected).toHaveBeenCalledWith("o")
	})

	it("opens a file whose protection was removed without a password, and keeps a kept one's", async () => {
		const seen = calls()
		const onProtected = vi.fn()

		await (
			await savePdfVersion(deps([written({ protection: { kind: "none" } })], { ok: true }, seen, { onProtected }), ITEM)
		).commit(ITEM)
		await (await savePdfVersion(deps([written()], { ok: true }, seen, { onProtected }), ITEM)).commit(ITEM)
		expect(seen.verifierPasswords).toEqual([undefined, "old"])
		expect(onProtected.mock.calls).toEqual([[undefined]])
	})

	it("asks before invalidating signatures and saves only once agreed", async () => {
		const refused: PdfSaveBegun = {
			status: "refused",
			plan: {
				mode: "full",
				encryption: "keep",
				invalidates: ["Sig1", "Sig2"],
				peakBytes: 1,
				options: "",
				refuse: "invalidatesSignatures"
			},
			reason: "invalidatesSignatures"
		}
		const confirmInvalidation = vi.fn((count: number) => Promise.resolve(count === 2))
		const seen = calls()

		await savePdfVersion(deps([refused, written()], { ok: true }, seen, { confirmInvalidation }), ITEM)
		expect(confirmInvalidation).toHaveBeenCalledWith(2)
		expect(seen.edit.filter(entry => entry.op === "saveBegin").map(entry => entry.args)).toMatchObject([
			{ invalidateConfirmed: false },
			{ invalidateConfirmed: true }
		])

		const declined = calls()
		const save = savePdfVersion(deps([refused], { ok: true }, declined, { confirmInvalidation: () => Promise.resolve(false) }), ITEM)

		await expect(save).rejects.toBeInstanceOf(SaveRefusedError)
		await expect(save).rejects.toMatchObject({ silent: true })
	})

	it("offers deleting earlier versions after a new version that removed content, where they are kept", async () => {
		const onEarlierVersions = vi.fn()
		const seen = calls()

		await (
			await savePdfVersion(deps([written({ removesContent: true })], { ok: true }, seen, { onEarlierVersions }), ITEM)
		).commit(ITEM)
		await (
			await savePdfVersion(
				deps([written({ removesContent: true })], { ok: true }, seen, {
					onEarlierVersions,
					versioning: () => false
				}),
				ITEM
			)
		).commit(ITEM)
		await (await savePdfVersion(deps([written()], { ok: true }, seen, { onEarlierVersions }), ITEM)).commit(ITEM)
		expect(onEarlierVersions).toHaveBeenCalledTimes(1)
	})

	it("goes on on the written file for a save a signing follows, even when earlier versions are kept", async () => {
		const plain = calls()
		const first = calls()

		await (await savePdfVersion(deps([written()], { ok: true }, plain), ITEM)).commit(ITEM)
		await (await savePdfVersion(deps([written()], { ok: true }, first), ITEM, true)).commit(ITEM)

		expect(plain.edit.at(-1)).toEqual({ op: "saveEnd", args: { outcome: "saved", next: "continue" } })
		expect(first.edit.at(-1)).toEqual({ op: "saveEnd", args: { outcome: "saved", next: "adopt" } })
	})
})

describe("redaction and protection rules", () => {
	const quad = [10, 10, 50, 10, 10, 20, 50, 20] as const
	const finding = (id: string, page: number): RedactionFinding => ({
		id,
		page,
		text: "x",
		quads: [quad],
		source: { kind: "term", index: 0 }
	})
	const mark = (page: number, kind: RedactionMark["kind"], quads: RedactionMark["quads"]): RedactionMark => ({
		id: page * 10,
		page,
		kind,
		rect: [0, 0, 100, 100],
		quads
	})

	it("counts a finding as marked only while a text mark on its page covers it", () => {
		const findings = [finding("0:0", 0), finding("1:0", 1), finding("2:0", 2)]
		const marks = [mark(0, "text", [quad]), mark(1, "area", []), mark(2, "text", [[60, 10, 90, 10, 60, 20, 90, 20]])]

		expect([...markedFindings(findings, marks)]).toEqual(["0:0"])
		expect(markedPages([mark(3, "text", [quad]), mark(1, "area", []), mark(3, "page", [])])).toEqual([1, 3])
	})

	it("tells a failed redaction check from any other save failure", () => {
		const failure = { code: "revisions", count: 2 } as const

		expect(isRedactionRefusal(new PdfRedactionRefusedError(failure))).toBe(true)
		expect(isRedactionRefusal(new SaveRefusedError("previewPdfSaveFailed"))).toBe(false)
		expect(isRedactionRefusal(null)).toBe(false)
	})

	it("reads pending redaction marks from pdf.js annotations, ignoring anything else", () => {
		expect(
			redactionRects([
				{ subtype: "Redact", rect: [1, 2, 3, 4] },
				{ subtype: "Link", rect: [1, 2, 3, 4] },
				{ subtype: "Redact", rect: [1, 2, Number.NaN, 4] },
				{ subtype: "Redact" },
				null
			])
		).toEqual([[1, 2, 3, 4]])
	})

	it("words every protection refusal and tells restricted from unlocked", () => {
		for (const reason of [
			"ownerRequired",
			"openPasswordUnknown",
			"notRc4",
			"unsupported",
			"emptyPassword",
			"passwordRefused",
			"samePasswords",
			"platform"
		] as const)
			expect(refusalKey(reason)).toMatch(/^previewPdf/)

		const state = (owner: boolean, edit: boolean) =>
			({ restrictions: { owner, edit, annotate: true, form: true, assemble: true, print: true } }) as unknown as PdfEditState

		expect(ownerRestricted(state(false, false))).toBe(true)
		expect(ownerRestricted(state(false, true))).toBe(false)
		expect(ownerRestricted(state(true, false))).toBe(false)
	})
})
