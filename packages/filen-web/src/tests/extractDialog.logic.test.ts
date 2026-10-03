import { describe, expect, it } from "vitest"
import {
	archiveNeededPassword,
	extractDialogReducer,
	extractSubmitStep,
	folderNameToCheck,
	initExtractDialog,
	shownFolderName,
	validateExtract,
	type ExtractDialogAction,
	type ExtractDialogState
} from "@/features/drive/components/extractDialog.logic"
import { ARCHIVE_FILE, compressJob, extractJob } from "@/tests/support/archiveJobFixtures"

const DESTINATION = { uuid: null, name: "My Drive" }
// The SDK took the typed name.
const OWN = { disposeAllowed: true, folderNameError: null }

function state(...actions: ExtractDialogAction[]): ExtractDialogState {
	return actions.reduce(extractDialogReducer, initExtractDialog({ destination: DESTINATION, passwordOpen: false }))
}

describe("extract dialog state", () => {
	it("starts into a new directory named after the archive, keeping the archive and leaving macOS metadata out", () => {
		expect(state()).toMatchObject({
			step: "edit",
			root: "newFolder",
			folderNameEdited: false,
			skipMacMetadata: true,
			afterwards: "keep",
			passwordOpen: false
		})
	})

	it("shows the archive's own directory name until one is typed, even an empty one", () => {
		expect(shownFolderName(state(), "photos")).toBe("photos")
		expect(shownFolderName(state({ type: "setFolderName", folderName: "" }), "photos")).toBe("")
	})
})

describe("validateExtract", () => {
	it("sends the SDK's own name for an untouched new directory and a typed one trimmed", () => {
		const untouched = validateExtract(state(), OWN)

		expect(untouched.ok && untouched.start).toEqual({
			root: "newFolder",
			folderName: undefined,
			password: undefined,
			skipMacMetadata: true,
			dispose: null
		})

		const typed = validateExtract(state({ type: "setFolderName", folderName: "  Holiday " }), OWN)

		expect(typed.ok && typed.start.folderName).toBe("Holiday")
	})

	it("refuses an empty directory name or one the SDK refuses, but not when extracting straight into the destination", () => {
		expect(validateExtract(state({ type: "setFolderName", folderName: " " }), OWN)).toEqual({
			ok: false,
			errors: { folderName: "Empty" }
		})
		expect(validateExtract(state({ type: "setFolderName", folderName: "a:b" }), { ...OWN, folderNameError: "ForbiddenChar" })).toEqual({
			ok: false,
			errors: { folderName: "ForbiddenChar" }
		})

		const direct = validateExtract(state({ type: "setFolderName", folderName: "" }, { type: "setRoot", root: "destination" }), OWN)

		expect(direct.ok && direct.start).toMatchObject({ root: "destination", folderName: undefined })
	})

	it("waits for the SDK's answer on a typed name, and asks about no other", () => {
		expect(validateExtract(state({ type: "setFolderName", folderName: "Holiday" }), { ...OWN, folderNameError: undefined })).toEqual({
			ok: false,
			errors: { folderName: "pending" }
		})
		expect(validateExtract(state(), { ...OWN, folderNameError: undefined }).ok).toBe(true)
		expect(folderNameToCheck(state({ type: "setFolderName", folderName: " Holiday " }))).toBe("Holiday")
		expect(folderNameToCheck(state())).toBeNull()
		expect(folderNameToCheck(state({ type: "setFolderName", folderName: " " }))).toBeNull()
		expect(
			folderNameToCheck(state({ type: "setFolderName", folderName: "Holiday" }, { type: "setRoot", root: "destination" }))
		).toBeNull()
	})

	it("refuses a password longer than 1024 characters, counting code points", () => {
		const open = { type: "setPasswordOpen", open: true } as const

		expect(validateExtract(state(open, { type: "setPassword", password: "a".repeat(1025) }), OWN)).toEqual({
			ok: false,
			errors: { password: "tooLong" }
		})
		expect(validateExtract(state(open, { type: "setPassword", password: "😀".repeat(1024) }), OWN).ok).toBe(true)
	})

	it("sends no password when it is empty or its section is closed", () => {
		const empty = validateExtract(state({ type: "setPasswordOpen", open: true }), OWN)

		expect(empty.ok && empty.start.password).toBeUndefined()

		const closed = validateExtract(state({ type: "setPassword", password: "secret" }), OWN)

		expect(closed.ok && closed.start.password).toBeUndefined()

		const open = validateExtract(state({ type: "setPasswordOpen", open: true }, { type: "setPassword", password: " secret " }), OWN)

		expect(open.ok && open.start.password).toBe(" secret ")
	})

	it("refuses removing an archive that is not the user's own", () => {
		expect(validateExtract(state({ type: "setAfterwards", afterwards: "trash" }), { ...OWN, disposeAllowed: false })).toEqual({
			ok: false,
			errors: { dispose: "notAllowed" }
		})
	})

	it("asks before deleting the archive for good, and starts once confirmed", () => {
		const deleting = state({ type: "setAfterwards", afterwards: "deletePermanently" })
		const validation = validateExtract(deleting, OWN)

		expect(validation.ok && validation.start.dispose).toBe("deletePermanently")
		expect(extractSubmitStep(deleting, validation)).toBe("confirmDelete")

		const confirming = extractDialogReducer(deleting, { type: "askDeleteConfirm" })

		expect(extractSubmitStep(confirming, validateExtract(confirming, OWN))).toBe("start")
		expect(extractDialogReducer(confirming, { type: "cancelDelete" }).step).toBe("edit")

		const trashing = state({ type: "setAfterwards", afterwards: "trash" })

		expect(extractSubmitStep(trashing, validateExtract(trashing, OWN))).toBe("start")
		expect(extractSubmitStep(state(), validateExtract(state({ type: "setFolderName", folderName: "" }), OWN))).toBe("invalid")
	})
})

describe("archiveNeededPassword", () => {
	it("finds an earlier extract of the same archive that stopped for its password", () => {
		const uuid = ARCHIVE_FILE.uuid

		expect(archiveNeededPassword({ a: extractJob({ outcome: { status: "wrongPassword" } }, "a") }, uuid)).toBe(true)
		expect(archiveNeededPassword({ a: extractJob({ outcome: { status: "passwordRequired" } }, "a") }, uuid)).toBe(true)
		expect(archiveNeededPassword({ a: extractJob({ outcome: { status: "done" } }, "a") }, uuid)).toBe(false)
		expect(archiveNeededPassword({ a: extractJob({ outcome: { status: "passwordRequired" } }, "a") }, "other")).toBe(false)
		expect(archiveNeededPassword({ c: compressJob({}, "c") }, uuid)).toBe(false)
	})
})
