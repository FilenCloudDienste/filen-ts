import { describe, expect, it, vi } from "vitest"
import type { File } from "@filen/sdk-rs"
import {
	addPdfSignature,
	emptyPdfSignatures,
	parsePdfSignatures,
	PDF_SIGNATURES_FILE_NAME,
	serializePdfSignatures
} from "@filen/shared/pdfSignatures"
import type { PdfVisualSignature } from "@filen/office/core/pdfedit/visualSignature"
import { driveFile } from "@/tests/support/videoDrive"

vi.mock("@/lib/sdk/client", () => ({ sdkApi: {} }))
vi.mock("@/lib/sdk/socket", () => ({ registerSocketHandler: () => () => undefined }))
vi.mock("@/lib/dotFilen", () => ({
	dotFilenSubdirUuid: () => null,
	findDotFilenSubdir: () => Promise.resolve(null),
	getDotFilenSubdir: () => Promise.resolve("office"),
	noteDotFilenFile: () => undefined,
	onDotFilenSubdirForgotten: () => () => undefined
}))

const { SavedSignaturesStore, savedVisualSignature } = await import("@/features/pdf/fillSign/savedSignatures")

const OFFICE = "00000000-0000-4000-8000-0000000000f3"

// `.filen/office` holding the saved-signatures file's versions.
function fakeDrive(initial?: string) {
	let dir: string | null = initial === undefined ? null : OFFICE
	let head: { file: File; text: string } | undefined
	let counter = 0
	const uploads: string[] = []

	const put = (text: string): File => {
		const file = driveFile(OFFICE, PDF_SIGNATURES_FILE_NAME, {
			uuid: `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
			timestamp: counter,
			size: text.length
		})

		head = { file, text }

		return file
	}

	if (initial !== undefined) put(initial)

	return {
		uploads,
		// Another device's save.
		replace: (text: string) => put(text),
		sdk: {
			dir: () => {
				dir = OFFICE

				return Promise.resolve(OFFICE)
			},
			findDir: () => Promise.resolve(dir),
			knownDir: () => dir,
			noteSystemFile: () => undefined,
			listDirectory: () => Promise.resolve(head === undefined ? [] : [head.file]),
			download: (file: File) => Promise.resolve(new TextEncoder().encode(head?.file.uuid === file.uuid ? head.text : "{}")),
			upload: (_parent: string, bytes: Uint8Array) => {
				const text = new TextDecoder().decode(bytes)

				uploads.push(text)

				return Promise.resolve(put(text))
			}
		}
	}
}

const drawn: PdfVisualSignature = { kind: "strokes", width: 1000, height: 300, strokes: [[0, 0, 500, 300, 1000, 0]] }
const picture: PdfVisualSignature = {
	kind: "image",
	width: 3,
	height: 1,
	png: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 255])
}

function counter(): () => string {
	let next = 0

	return () => `id-${String(++next)}`
}

describe("saved PDF signatures store", () => {
	it("saves strokes and images to .filen/office and reads them back as they were placed", async () => {
		const drive = fakeDrive()
		const store = new SavedSignaturesStore(drive.sdk, () => 1000, counter())

		await store.load()
		await store.save("signature", drawn)
		await store.save("initials", picture)

		expect(drive.uploads).toHaveLength(2)

		const stored = parsePdfSignatures(drive.uploads.at(-1) ?? "")

		expect(stored.items.map(item => item.role).sort()).toEqual(["initials", "signature"])

		// A fresh session (another device) reads the same signatures.
		const other = new SavedSignaturesStore(drive.sdk)

		await other.load()

		const view = other.view()

		expect(view.loaded).toBe(true)
		expect(view.signatures).toHaveLength(1)
		expect(view.initials).toHaveLength(1)
		expect(savedVisualSignature(view.signatures[0] ?? view.initials[0] ?? neverSaved())).toEqual(drawn)

		const image = savedVisualSignature(view.initials[0] ?? neverSaved())

		expect(image).toEqual(picture)
		// Decoded once per entry.
		expect(savedVisualSignature(view.initials[0] ?? neverSaved())).toBe(image)
	})

	it("deletes, and merges with another device's additions instead of dropping them", async () => {
		const drive = fakeDrive()
		const store = new SavedSignaturesStore(drive.sdk, () => 2000, counter())

		await store.load()

		const first = await store.save("signature", drawn)

		// Another device adds one meanwhile.
		const theirs = addPdfSignature(parsePdfSignatures(drive.uploads.at(-1) ?? "{}"), {
			id: "remote",
			role: "signature",
			at: 1500,
			data: { kind: "strokes", width: 10, height: 10, strokes: [[1, 1, 9, 9]] }
		})

		drive.replace(serializePdfSignatures(theirs))
		store.markStale()
		await store.delete(first.id)

		expect(store.view().signatures.map(item => item.id)).toEqual(["remote"])
		expect(parsePdfSignatures(drive.uploads.at(-1) ?? "").items.map(item => item.id)).toEqual(["remote"])
	})

	it("keeps a newer app's file unchanged and refuses to save into it", async () => {
		const drive = fakeDrive(JSON.stringify({ v: 99, items: [] }))
		const store = new SavedSignaturesStore(drive.sdk)

		await store.load()

		expect(store.view().readOnly).toBe(true)
		await expect(store.save("signature", drawn)).rejects.toThrow()
		expect(drive.uploads).toEqual([])
	})

	it("refuses a signature too large to store", async () => {
		const drive = fakeDrive(serializePdfSignatures(emptyPdfSignatures()))
		const store = new SavedSignaturesStore(drive.sdk)

		await store.load()
		await expect(store.save("signature", { ...picture, png: new Uint8Array(400 * 1024) })).rejects.toThrow()
		expect(drive.uploads).toEqual([])
	})

	it("forgets everything on sign-out", async () => {
		const drive = fakeDrive()
		const store = new SavedSignaturesStore(drive.sdk, () => 1, counter())

		await store.load()
		await store.save("signature", drawn)
		store.reset()

		expect(store.view()).toMatchObject({ loaded: false, signatures: [], initials: [] })
	})
})

function neverSaved(): never {
	throw new Error("not saved")
}
