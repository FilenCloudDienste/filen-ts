import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { Dir, File, LinkedFile, UserInfo, UuidStr } from "@filen/sdk-rs"

vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import "@/lib/i18n"
import { narrowItem, type DriveItem } from "@/features/drive/lib/item"
import { FORMAT_CHOICES, type FormatChoiceId, type SevenZMethodId, type ZipMethodId } from "@/features/drive/lib/archiveFormats"
import { DEFAULT_COMPRESS_PREFERENCES, type CompressPreferences } from "@/features/drive/lib/compressPreferences"
import {
	CATALOGUE,
	catalogueLookup,
	compressArchiveName,
	compressDialogReducer,
	compressNameToCheck,
	compressSubjectFacts,
	initCompressDialog,
	validateCompress,
	visibleCompressErrors,
	type CompressDialogAction,
	type CompressDialogState,
	type CompressValidationContext
} from "@/features/drive/components/compressDialog.logic"
import { namingEntries } from "@/features/drive/lib/archiveTargets"
import type { ArchiveFormatInfo } from "@/workers/sdk.worker"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY } from "@/queries/account"
import { testUuid } from "@/tests/support/uuid"

const ROOT = testUuid("root")
const PARENT = testUuid("parent")
const OTHER = testUuid("other")

function file(name: string, parent: UuidStr = PARENT): DriveItem {
	const raw: File = {
		uuid: testUuid(name),
		stableUUID: undefined,
		parent,
		size: 100n,
		favorited: false,
		region: "de-1",
		bucket: "filen-1",
		timestamp: 0n,
		chunks: 1n,
		canMakeThumbnail: false,
		meta: { type: "decoded", data: { name, mime: "application/octet-stream", modified: 0n, size: 100n, key: "k", version: 2 } }
	}

	return narrowItem(raw)
}

function dir(name: string): DriveItem {
	const raw: Dir = {
		uuid: testUuid(name),
		parent: PARENT,
		color: "default",
		timestamp: 0n,
		favorited: false,
		meta: { type: "decoded", data: { name } }
	}

	return narrowItem(raw)
}

const EXTENSIONS: Record<FormatChoiceId, string> = Object.fromEntries(
	FORMAT_CHOICES.map(choice => [choice.id, choice.displayExtension])
) as Record<FormatChoiceId, string>

// Levels 1–9, of which the budget runs up to 5, for every format with levels.
function info(choice: FormatChoiceId, method: ZipMethodId | SevenZMethodId | null, maxLevel: number | null = 5): ArchiveFormatInfo {
	const levelless = choice === "tar" || method === "stored" || method === "copy"

	return {
		extension: EXTENSIONS[choice],
		levels: levelless ? null : { min: 1, max: 9, defaultLevel: 6 },
		maxLevel: levelless ? null : maxLevel,
		encoderMemory: levelless ? null : 1024
	}
}

function ctx(overrides: Partial<CompressValidationContext> = {}): CompressValidationContext {
	// The SDK took the name.
	return { infoFor: (choice, method) => info(choice, method), singleFile: true, disposeAllowed: true, nameError: null, ...overrides }
}

function init(
	items: DriveItem[],
	prefs: CompressPreferences = DEFAULT_COMPRESS_PREFERENCES,
	allowed?: FormatChoiceId[]
): CompressDialogState {
	return initCompressDialog({
		prefs,
		naming: { entries: namingEntries(items), parentName: "Photos", fallback: "Archive" },
		destination: { uuid: PARENT, name: "Photos" },
		allowed: allowed ?? FORMAT_CHOICES.map(choice => choice.id)
	})
}

function run(state: CompressDialogState, ...actions: CompressDialogAction[]): CompressDialogState {
	return actions.reduce(compressDialogReducer, state)
}

describe("catalogue", () => {
	it("asks for every format, and for zip and 7z at each method", () => {
		expect(new Set(CATALOGUE.map(entry => entry.choice))).toEqual(new Set(FORMAT_CHOICES.map(choice => choice.id)))
		expect(CATALOGUE.filter(entry => entry.choice === "zip").map(entry => entry.method)).toEqual(["stored", "deflate", "bzip2"])
		expect(CATALOGUE.filter(entry => entry.choice === "7z")).toHaveLength(6)
		expect(CATALOGUE.find(entry => entry.choice === "7z" && entry.method === "ppmd")?.probe).toMatchObject({
			type: "sevenZ",
			method: { type: "ppmd" }
		})
	})

	it("looks an answer up by format and method", () => {
		const infos = CATALOGUE.map(entry => info(entry.choice, entry.method, entry.method === "bzip2" ? 3 : 5))
		const lookup = catalogueLookup(infos)

		expect(lookup("zip", "bzip2")?.maxLevel).toBe(3)
		expect(lookup("zip", "deflate")?.maxLevel).toBe(5)
		expect(lookup("zip", "stored")?.levels).toBeNull()
		expect(lookup("tar.gz", null)?.extension).toBe(".tar.gz")
		expect(lookup("tar.gz", "deflate")).toBeUndefined()
	})
})

describe("initCompressDialog", () => {
	it("opens on the remembered format and options, keeping the originals", () => {
		const prefs: CompressPreferences = {
			format: "7z",
			zip: { method: "bzip2", level: 4, aes: "aes128" },
			sevenZ: { method: "ppmd", level: 7, solid: false, encryptNames: false },
			levels: { "tar.xz": 2 }
		}
		const state = init([file("report.pdf")], prefs)

		expect(state).toMatchObject({
			step: "edit",
			choice: "7z",
			base: "report",
			nameEdited: false,
			zipMethod: "bzip2",
			sevenZMethod: "ppmd",
			solid: false,
			aes: "aes128",
			encryptNames: false,
			protect: false,
			password: "",
			afterwards: "keep",
			levels: { zip: 4, "7z": 7, "tar.xz": 2 }
		})
	})

	it("falls back to the first allowed format when the remembered one can't take the selection", () => {
		const state = init([file("a.txt"), file("b.txt")], { ...DEFAULT_COMPRESS_PREFERENCES, format: "gz" }, ["zip", "7z"])

		expect(state.choice).toBe("zip")
		expect(state.base).toBe("Photos")
	})
})

describe("compressDialogReducer", () => {
	it("re-derives the name from the format until it is edited", () => {
		const state = init([file("report.pdf")])

		expect(state.base).toBe("report")
		expect(run(state, { type: "setChoice", choice: "gz" }).base).toBe("report.pdf")
		expect(run(state, { type: "setChoice", choice: "gz" }, { type: "setChoice", choice: "7z" }).base).toBe("report")

		const edited = run(state, { type: "setBase", value: "Q3" }, { type: "setChoice", choice: "gz" })

		expect(edited.base).toBe("Q3")
		expect(edited.nameEdited).toBe(true)
	})

	it("keeps the password over a format switch", () => {
		const state = run(
			init([dir("Docs")]),
			{ type: "setProtect", value: true },
			{ type: "setPassword", value: "secret" },
			{ type: "setConfirm", value: "secret" },
			{ type: "setChoice", choice: "tar.gz" },
			{ type: "setChoice", choice: "zip" }
		)

		expect(state).toMatchObject({ protect: true, password: "secret", confirm: "secret" })
	})

	it("stores a picked level per format", () => {
		const state = run(
			init([dir("Docs")]),
			{ type: "setLevel", level: 3 },
			{ type: "setChoice", choice: "tar.xz" },
			{ type: "setLevel", level: 8 }
		)

		expect(state.levels).toEqual({ zip: 3, "tar.xz": 8 })
	})

	it("asks for confirmation before a valid permanent deletion, and goes back on cancel", () => {
		const deleting = run(init([dir("Docs")]), { type: "setAfterwards", value: "deletePermanently" })

		expect(run(deleting, { type: "requestSubmit", valid: true }).step).toBe("confirmDelete")
		expect(run(deleting, { type: "requestSubmit", valid: false }).step).toBe("edit")
		expect(run(deleting, { type: "requestSubmit", valid: true }, { type: "cancelDelete" }).step).toBe("edit")
		expect(run(init([dir("Docs")]), { type: "requestSubmit", valid: true })).toMatchObject({ step: "edit", submitAttempted: true })
	})

	it("toggles reveal and the advanced section", () => {
		const state = run(init([dir("Docs")]), { type: "toggleReveal" }, { type: "toggleAdvanced" })

		expect(state).toMatchObject({ reveal: true, advancedOpen: true })
		expect(run(state, { type: "toggleReveal" }).reveal).toBe(false)
	})
})

describe("validateCompress", () => {
	it("starts a zip named after the item, at the remembered level clamped to what the budget runs", () => {
		const state = init([file("report.pdf")], { ...DEFAULT_COMPRESS_PREFERENCES, zip: { method: "deflate", level: 9, aes: "aes256" } })
		const result = validateCompress(state, ctx())

		expect(result).toEqual({
			ok: true,
			start: {
				name: "report.zip",
				format: { type: "zip", method: { type: "deflate", level: 5 } },
				encrypted: false,
				dispose: null,
				password: undefined,
				prefs: {
					choice: "zip",
					options: { level: 5, zipMethod: "deflate", sevenZMethod: "lzma2", solid: true, aes: "aes256", encryptNames: true }
				}
			}
		})
	})

	it("uses the SDK's default level when none was picked, and none for a format without levels", () => {
		const leveled = validateCompress(init([dir("Docs")]), ctx())
		const plain = validateCompress(run(init([dir("Docs")]), { type: "setChoice", choice: "tar" }), ctx())

		expect(leveled.ok && leveled.start.format).toEqual({ type: "zip", method: { type: "deflate", level: 5 } })
		expect(plain.ok && plain.start).toMatchObject({ name: "Docs.tar", format: { type: "tar" } })
	})

	it("encrypts a zip with the chosen strength and hands over the password", () => {
		const state = run(
			init([dir("Docs")]),
			{ type: "setProtect", value: true },
			{ type: "setPassword", value: "pw" },
			{ type: "setConfirm", value: "pw" },
			{ type: "setAes", value: "aes192" }
		)
		const result = validateCompress(state, ctx())

		expect(result.ok && result.start).toMatchObject({
			encrypted: true,
			password: "pw",
			format: { type: "zip", encryption: "aes192" }
		})
		expect(result.ok && JSON.stringify(result.start.prefs)).not.toContain("pw")
	})

	it("hides 7z names unless told not to", () => {
		const base = run(
			init([dir("Docs")]),
			{ type: "setChoice", choice: "7z" },
			{ type: "setProtect", value: true },
			{ type: "setPassword", value: "pw" },
			{ type: "setConfirm", value: "pw" }
		)
		const hidden = validateCompress(base, ctx())
		const shown = validateCompress(run(base, { type: "setEncryptNames", value: false }), ctx())

		expect(hidden.ok && hidden.start.format).toMatchObject({ type: "sevenZ", encryption: "entriesAndHeaders", solid: true })
		expect(shown.ok && shown.start.format).toMatchObject({ type: "sevenZ", encryption: "entries" })
	})

	it("needs a password and a matching confirmation", () => {
		const protectedState = run(init([dir("Docs")]), { type: "setProtect", value: true })

		expect(validateCompress(protectedState, ctx())).toEqual({ ok: false, errors: { password: "empty" } })
		expect(
			validateCompress(run(protectedState, { type: "setPassword", value: "a" }, { type: "setConfirm", value: "b" }), ctx())
		).toEqual({ ok: false, errors: { confirm: "mismatch" } })
		expect(validateCompress(run(protectedState, { type: "setPassword", value: "a" }), ctx())).toEqual({
			ok: false,
			errors: { confirm: "mismatch" }
		})
	})

	it("refuses a password longer than 1024 characters, counting code points", () => {
		const protectedState = run(init([dir("Docs")]), { type: "setProtect", value: true })
		const long = "a".repeat(1025)
		const emoji = "😀".repeat(1024)

		expect(
			validateCompress(run(protectedState, { type: "setPassword", value: long }, { type: "setConfirm", value: long }), ctx())
		).toEqual({
			ok: false,
			errors: { password: "tooLong" }
		})
		expect(
			validateCompress(run(protectedState, { type: "setPassword", value: emoji }, { type: "setConfirm", value: emoji }), ctx()).ok
		).toBe(true)
	})

	it("ignores the password for a format that can't hold one", () => {
		const state = run(
			init([dir("Docs")]),
			{ type: "setProtect", value: true },
			{ type: "setPassword", value: "pw" },
			{ type: "setChoice", choice: "tar.gz" }
		)
		const result = validateCompress(state, ctx())

		expect(result.ok && result.start).toMatchObject({ encrypted: false, password: undefined, name: "Docs.tar.gz" })
	})

	it("refuses a format the budget can't run, and a single-file format for anything but one file", () => {
		const unavailable = ctx({ infoFor: (choice, method) => info(choice, method, null) })

		expect(validateCompress(init([dir("Docs")]), unavailable)).toEqual({ ok: false, errors: { format: "unavailable" } })
		expect(validateCompress(run(init([dir("Docs")]), { type: "setChoice", choice: "gz" }), ctx({ singleFile: false }))).toEqual({
			ok: false,
			errors: { format: "needsOneFile" }
		})
		expect(validateCompress(init([dir("Docs")]), ctx({ infoFor: () => undefined }))).toEqual({
			ok: false,
			errors: { format: "unavailable" }
		})
	})

	it("refuses an empty name and one the SDK refuses, and waits for its answer", () => {
		const state = init([dir("Docs")])

		expect(validateCompress(run(state, { type: "setBase", value: "  " }), ctx())).toEqual({ ok: false, errors: { name: "Empty" } })
		expect(validateCompress(run(state, { type: "setBase", value: "a:b" }), ctx({ nameError: "ForbiddenChar" }))).toEqual({
			ok: false,
			errors: { name: "ForbiddenChar" }
		})
		expect(validateCompress(state, ctx({ nameError: undefined }))).toEqual({ ok: false, errors: { name: "pending" } })
		expect(validateCompress(run(state, { type: "setBase", value: " Q3.zip " }), ctx())).toMatchObject({
			ok: true,
			start: { name: "Q3.zip" }
		})
	})

	it("names a single compressed file after the whole file, refusing a name the SDK reads as another format", () => {
		const tarball = run(init([file("backup.tar")]), { type: "setChoice", choice: "gz" })

		expect(validateCompress(tarball, ctx({ nameFormat: { type: "tar", codec: "gzip" } }))).toEqual({
			ok: false,
			errors: { name: "otherFormat" }
		})
		expect(validateCompress(tarball, ctx({ nameFormat: null }))).toEqual({ ok: false, errors: { name: "otherFormat" } })
		expect(validateCompress(tarball, ctx({ nameFormat: { type: "single", codec: "xz" } }))).toEqual({
			ok: false,
			errors: { name: "otherFormat" }
		})

		const gzipped = run(init([file("x.tar.gz")]), { type: "setChoice", choice: "gz" })

		expect(validateCompress(gzipped, ctx({ nameFormat: { type: "single", codec: "gzip" } }))).toMatchObject({
			ok: true,
			start: { name: "x.tar.gz.gz", format: { type: "single", compression: { codec: "gzip" } } }
		})
	})

	it("waits for the SDK's reading of a single compressed file's name, quietly", () => {
		const state = run(init([file("notes.txt")]), { type: "setChoice", choice: "gz" })
		const pending = validateCompress(state, ctx())

		expect(pending).toEqual({ ok: false, errors: { name: "pending" } })
		expect(!pending.ok && visibleCompressErrors(run(state, { type: "requestSubmit", valid: false }), pending.errors)).toEqual({})
	})

	it("disposes only where allowed", () => {
		const trashing = run(init([dir("Docs")]), { type: "setAfterwards", value: "trash" })

		expect(validateCompress(trashing, ctx()).ok && validateCompress(trashing, ctx())).toMatchObject({ start: { dispose: "trash" } })
		expect(validateCompress(trashing, ctx({ disposeAllowed: false }))).toEqual({ ok: false, errors: { dispose: "notAllowed" } })
	})
})

describe("compressArchiveName / compressNameToCheck", () => {
	const infoFor: CompressValidationContext["infoFor"] = (choice, method) => info(choice, method)

	it("puts the codec's extension on a single compressed file's whole name until the name is edited", () => {
		const state = run(init([file("notes.gz")]), { type: "setChoice", choice: "gz" })

		expect(compressArchiveName(state, ".gz")).toBe("notes.gz.gz")
		expect(compressArchiveName(run(state, { type: "setBase", value: "Q3.gz" }), ".gz")).toBe("Q3.gz")
		expect(compressArchiveName(init([file("notes.gz")]), ".zip")).toBe("notes.zip")
	})

	it("asks the SDK about the whole archive name, once there is a base name and an extension", () => {
		const state = init([file("backup.tar")])

		expect(compressNameToCheck(state, infoFor)).toBe("backup.zip")
		expect(compressNameToCheck(run(state, { type: "setChoice", choice: "tar.gz" }), infoFor)).toBe("backup.tar.gz")
		expect(compressNameToCheck(run(state, { type: "setChoice", choice: "gz" }), infoFor)).toBe("backup.tar.gz")
		expect(compressNameToCheck(run(state, { type: "setChoice", choice: "gz" }, { type: "setBase", value: " " }), infoFor)).toBeNull()
		expect(compressNameToCheck(run(state, { type: "setChoice", choice: "gz" }), () => undefined)).toBeNull()
	})
})

describe("visibleCompressErrors", () => {
	it("keeps an untouched password form quiet until a confirmation is typed or a submit is tried", () => {
		const state = run(init([dir("Docs")]), { type: "setProtect", value: true })
		const errors = { password: "empty", confirm: "mismatch" } as const

		expect(visibleCompressErrors(state, errors)).toEqual({})
		expect(visibleCompressErrors(run(state, { type: "setConfirm", value: "x" }), errors)).toEqual({ confirm: "mismatch" })
		expect(visibleCompressErrors(run(state, { type: "requestSubmit", valid: false }), errors)).toEqual(errors)
	})

	it("says at once that a password is too long", () => {
		const state = run(init([dir("Docs")]), { type: "setProtect", value: true })

		expect(visibleCompressErrors(state, { password: "tooLong" })).toEqual({ password: "tooLong" })
	})
})

describe("compressSubjectFacts", () => {
	const NAMES: Record<string, string> = { [PARENT]: "Holiday", [OTHER]: "Work" }
	const facts = (subject: Parameters<typeof compressSubjectFacts>[0]) =>
		compressSubjectFacts(subject, { rootName: "My Drive", fallback: "Archive", nameOf: uuid => NAMES[uuid] })

	queryClient.setQueryData<Partial<UserInfo>>(ACCOUNT_QUERY_KEY, { rootDirUuid: ROOT })

	it("compresses own drive items next to them, may remove them and prunes them from the selection", () => {
		const items = [file("a.txt"), dir("b")]

		expect(facts({ kind: "drive", items, variant: "drive" })).toEqual({
			naming: { entries: namingEntries(items), parentName: "Holiday", fallback: "Archive" },
			singleFile: false,
			disposeAllowed: true,
			destination: { uuid: PARENT, name: "Holiday" },
			pickerSources: items,
			source: { kind: "items", items },
			itemCount: 2,
			selectionUuids: items.map(item => item.data.uuid)
		})
	})

	it("keeps someone else's items and saves to My Drive's root in Shared with me", () => {
		const result = facts({ kind: "drive", items: [file("a.txt")], variant: "sharedIn" })

		expect(result.disposeAllowed).toBe(false)
		expect(result.singleFile).toBe(true)
		expect(result.destination).toEqual({ uuid: null, name: "My Drive" })
	})

	it("reads names through the caller's own lookup and names a mix of directories after its fallback", () => {
		const items = [file("a.jpg"), file("b.jpg", OTHER)]
		const own = (uuid: string) => (uuid === PARENT ? "Italy" : undefined)

		expect(facts({ kind: "drive", items, variant: "drive", parentNaming: { mixedFallback: "Photos" } }).naming.parentName).toBe(
			"Photos"
		)
		expect(
			facts({ kind: "drive", items: [file("a.jpg"), file("b.jpg")], variant: "drive", parentNaming: { nameOf: own } })
		).toMatchObject({
			naming: { parentName: "Italy" },
			destination: { uuid: PARENT, name: "Italy" }
		})
		// Without the fallback a mix keeps the drive's own rule.
		expect(facts({ kind: "drive", items, variant: "drive" }).naming.parentName).toBeNull()
	})

	it("saves a public link's item to My Drive's root, never removing it and pruning nothing", () => {
		const linked: LinkedFile = {
			uuid: testUuid("linked"),
			name: { Decrypted: "photo.jpg" },
			mime: { Decrypted: "image/jpeg" },
			size: 1024n,
			chunks: 1n,
			region: "de-1",
			bucket: "filen-1",
			version: 2,
			timestamp: 0n,
			fileKey: "k",
			downloadable: true,
			linkedTag: true,
			canMakeThumbnail: false
		}
		const naming = [{ name: "photo.jpg", directory: false }]

		expect(facts({ kind: "linked", items: [linked], naming })).toEqual({
			naming: { entries: naming, parentName: null, fallback: "Archive" },
			singleFile: true,
			disposeAllowed: false,
			destination: { uuid: null, name: "My Drive" },
			pickerSources: [],
			source: { kind: "linked", items: [linked] },
			itemCount: 1,
			selectionUuids: []
		})
		expect(facts({ kind: "linked", items: [linked], naming: [{ name: "Shared", directory: true }] }).singleFile).toBe(false)
	})
})
