import type { EntryNameErrorKindJS } from "@filen/sdk-rs"
import type { JobDestination } from "@filen/shared"
import { archivePasswordProblem } from "@/features/drive/lib/archivePassword"
import type { DriveJob } from "@/features/drive/lib/driveJobs.logic"
import type { AfterwardsValue } from "@/features/drive/components/afterwardsField"

// The extract options dialog's state (extractDialog.tsx), pure.

export type ExtractAfterwards = AfterwardsValue

export interface ExtractDialogState {
	step: "edit" | "confirmDelete"
	destination: JobDestination
	root: "newFolder" | "destination"
	// What the user typed; until then the field shows the SDK's name for the new directory.
	folderName: string
	folderNameEdited: boolean
	passwordOpen: boolean
	password: string
	reveal: boolean
	skipMacMetadata: boolean
	afterwards: ExtractAfterwards
}

export type ExtractDialogAction =
	| { type: "setDestination"; destination: JobDestination }
	| { type: "setRoot"; root: "newFolder" | "destination" }
	| { type: "setFolderName"; folderName: string }
	| { type: "setPasswordOpen"; open: boolean }
	| { type: "setPassword"; password: string }
	| { type: "toggleReveal" }
	| { type: "setSkipMacMetadata"; skip: boolean }
	| { type: "setAfterwards"; afterwards: ExtractAfterwards }
	| { type: "askDeleteConfirm" }
	| { type: "cancelDelete" }

export interface ExtractDialogInit {
	destination: JobDestination
	passwordOpen: boolean
}

export function initExtractDialog(init: ExtractDialogInit): ExtractDialogState {
	return {
		step: "edit",
		destination: init.destination,
		root: "newFolder",
		folderName: "",
		folderNameEdited: false,
		passwordOpen: init.passwordOpen,
		password: "",
		reveal: false,
		skipMacMetadata: true,
		afterwards: "keep"
	}
}

export function extractDialogReducer(state: ExtractDialogState, action: ExtractDialogAction): ExtractDialogState {
	switch (action.type) {
		case "setDestination":
			return { ...state, destination: action.destination }
		case "setRoot":
			return { ...state, root: action.root }
		case "setFolderName":
			return { ...state, folderName: action.folderName, folderNameEdited: true }
		case "setPasswordOpen":
			return { ...state, passwordOpen: action.open }
		case "setPassword":
			return { ...state, password: action.password }
		case "toggleReveal":
			return { ...state, reveal: !state.reveal }
		case "setSkipMacMetadata":
			return { ...state, skipMacMetadata: action.skip }
		case "setAfterwards":
			return { ...state, afterwards: action.afterwards }
		case "askDeleteConfirm":
			return { ...state, step: "confirmDelete" }
		case "cancelDelete":
			return { ...state, step: "edit" }
	}
}

export interface ExtractDialogContext {
	disposeAllowed: boolean
	// Why the SDK refuses folderNameToCheck's name (null: it takes it); undefined until answered.
	folderNameError: EntryNameErrorKindJS | null | undefined
}

export interface ExtractStart {
	root: "newFolder" | "destination"
	// Only a name the user typed; the SDK names an untouched new directory after the archive.
	folderName: string | undefined
	// The SDK refuses an empty password, so none is sent then.
	password: string | undefined
	skipMacMetadata: boolean
	dispose: Exclude<AfterwardsValue, "keep"> | null
}

export interface ExtractErrors {
	// Why the SDK refuses the typed name ("Empty" for none); "pending": not asked yet.
	folderName?: EntryNameErrorKindJS | "pending"
	password?: "tooLong"
	dispose?: "notAllowed"
}

export type ExtractValidation = { ok: true; start: ExtractStart } | { ok: false; errors: ExtractErrors }

// The directory name the field shows.
export function shownFolderName(state: ExtractDialogState, defaultName: string): string {
	return state.folderNameEdited ? state.folderName : defaultName
}

// The typed name of the new directory the SDK has to take; null while the SDK names it (its own name
// always passes), and for no name at all.
export function folderNameToCheck(state: ExtractDialogState): string | null {
	const folderName = state.folderName.trim()

	return state.root === "newFolder" && state.folderNameEdited && folderName.length > 0 ? folderName : null
}

export function validateExtract(state: ExtractDialogState, context: ExtractDialogContext): ExtractValidation {
	const root = state.root
	const edited = root === "newFolder" && state.folderNameEdited
	const folderName = state.folderName.trim()
	// An empty field sends none, which the SDK refuses.
	const password = state.passwordOpen && state.password.length > 0 ? state.password : undefined
	const errors: ExtractErrors = {}

	if (edited) {
		if (folderName.length === 0) {
			errors.folderName = "Empty"
		} else if (context.folderNameError === undefined) {
			errors.folderName = "pending"
		} else if (context.folderNameError !== null) {
			errors.folderName = context.folderNameError
		}
	}

	if (password !== undefined && archivePasswordProblem(password) === "tooLong") {
		errors.password = "tooLong"
	}

	if (state.afterwards !== "keep" && !context.disposeAllowed) {
		errors.dispose = "notAllowed"
	}

	if (Object.keys(errors).length > 0) {
		return { ok: false, errors }
	}

	return {
		ok: true,
		start: {
			root,
			folderName: edited ? folderName : undefined,
			password,
			skipMacMetadata: state.skipMacMetadata,
			dispose: state.afterwards === "keep" ? null : state.afterwards
		}
	}
}

// What a submit does next: stop at the errors (each field shows its own), ask before deleting the
// archive for good, or start.
export function extractSubmitStep(state: ExtractDialogState, validation: ExtractValidation): "invalid" | "confirmDelete" | "start" {
	if (!validation.ok) {
		return "invalid"
	}

	return validation.start.dispose === "deletePermanently" && state.step === "edit" ? "confirmDelete" : "start"
}

// Whether an earlier run on this archive already stopped for want of a (right) password: one scan, at mount.
export function archiveNeededPassword(jobs: Readonly<Record<string, DriveJob>>, archiveUuid: string): boolean {
	for (const job of Object.values(jobs)) {
		if (
			job.kind === "extract" &&
			job.archiveUuid === archiveUuid &&
			(job.outcome.status === "passwordRequired" || job.outcome.status === "wrongPassword")
		) {
			return true
		}
	}

	return false
}
