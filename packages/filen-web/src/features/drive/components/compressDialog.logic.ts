import type { AesStrength, AnyItemWithContext, ArchiveFormat, CompressFormat, EntryNameErrorKindJS } from "@filen/sdk-rs"
import type { JobDestination, SourceDisposalKind } from "@filen/shared"
import type { ArchiveFormatInfo } from "@/workers/sdk.worker"
import type { DriveItem } from "@/features/drive/lib/item"
import type { DriveVariant } from "@/features/drive/lib/preferences"
import type { CompressSource } from "@/features/drive/lib/archiveJobs.logic"
import {
	buildCompressFormat,
	effectiveLevel,
	FORMAT_CHOICES,
	formatChoice,
	isFormatRunnable,
	probeFormat,
	SEVENZ_METHODS,
	ZIP_METHODS,
	type FormatChoiceId,
	type FormatOptions,
	type SevenZMethodId,
	type ZipMethodId
} from "@/features/drive/lib/archiveFormats"
import { presetOptions, type CompressPreferences } from "@/features/drive/lib/compressPreferences"
import {
	archiveParentName,
	canDisposeSources,
	composeArchiveName,
	defaultArchiveBaseName,
	defaultJobDestination,
	namingEntries,
	type NameOf,
	type NamingEntry,
	type ParentNaming
} from "@/features/drive/lib/archiveTargets"
import { archivePasswordProblem, type ArchivePasswordProblem } from "@/features/drive/lib/archivePassword"
import type { AfterwardsValue } from "@/features/drive/components/afterwardsField"

// The compress dialog's form as a pure state machine, so every rule (the name following the format
// until edited, the password surviving a format switch, the delete confirmation) is testable without
// rendering.

// What the name is derived from until the user edits it; fixed for the dialog's life.
export interface NamingInput {
	entries: readonly NamingEntry[]
	parentName: string | null
	fallback: string
}

// What the dialog compresses: drive items (own or shared with the user), or what a public link points at,
// which only ever lands in the user's own drive and is never removed.
export type CompressSubject =
	| { kind: "drive"; items: DriveItem[]; variant: DriveVariant; parentNaming?: ParentNaming | undefined }
	| { kind: "linked"; items: AnyItemWithContext[]; naming: NamingEntry[] }

export interface CompressSubjectFacts {
	naming: NamingInput
	singleFile: boolean
	disposeAllowed: boolean
	destination: JobDestination
	// What the destination can't lie inside.
	pickerSources: DriveItem[]
	source: CompressSource
	itemCount: number
	// Pruned from the selection when the originals are to be removed.
	selectionUuids: string[]
}

export interface CompressSubjectContext {
	rootName: string
	fallback: string
	nameOf: NameOf
}

const NO_ITEMS: DriveItem[] = []
const NO_UUIDS: string[] = []

function isSingleFile(entries: readonly NamingEntry[]): boolean {
	const [only] = entries

	return entries.length === 1 && only !== undefined && !only.directory
}

export function compressSubjectFacts(subject: CompressSubject, ctx: CompressSubjectContext): CompressSubjectFacts {
	if (subject.kind === "linked") {
		return {
			naming: { entries: subject.naming, parentName: null, fallback: ctx.fallback },
			singleFile: isSingleFile(subject.naming),
			disposeAllowed: false,
			destination: { uuid: null, name: ctx.rootName },
			pickerSources: NO_ITEMS,
			source: { kind: "linked", items: subject.items },
			itemCount: subject.items.length,
			selectionUuids: NO_UUIDS
		}
	}

	const { items, variant } = subject
	const nameOf = subject.parentNaming?.nameOf ?? ctx.nameOf
	const entries = namingEntries(items)

	return {
		naming: { entries, parentName: archiveParentName(items, nameOf, subject.parentNaming?.mixedFallback), fallback: ctx.fallback },
		singleFile: isSingleFile(entries),
		disposeAllowed: canDisposeSources(variant, items),
		destination: defaultJobDestination(items, variant, ctx.rootName, nameOf),
		pickerSources: items,
		source: { kind: "items", items },
		itemCount: items.length,
		selectionUuids: items.map(item => item.data.uuid)
	}
}

export interface CompressDialogState {
	step: "edit" | "confirmDelete"
	naming: NamingInput
	base: string
	nameEdited: boolean
	choice: FormatChoiceId
	// The level picked per format; a format not touched yet holds its remembered one, if any.
	levels: Partial<Record<FormatChoiceId, number>>
	zipMethod: ZipMethodId
	sevenZMethod: SevenZMethodId
	solid: boolean
	aes: AesStrength
	encryptNames: boolean
	protect: boolean
	password: string
	confirm: string
	reveal: boolean
	afterwards: AfterwardsValue
	destination: JobDestination
	advancedOpen: boolean
	submitAttempted: boolean
}

// For the format questions: asked once a page and never refetched. The answers depend on the codec
// budget this page loaded with, so each query passes `noDiskPersister` itself (its data type is then
// still inferred from its queryFn).
export const PAGE_QUERY_OPTIONS = {
	staleTime: Infinity,
	gcTime: Infinity,
	refetchOnWindowFocus: false,
	refetchOnReconnect: false
} as const

export interface CatalogueEntry {
	choice: FormatChoiceId
	method: ZipMethodId | SevenZMethodId | null
	probe: CompressFormat
}

// Every format at each of its methods, so the dialog asks about all of them in one worker call and
// switching method needs none.
export const CATALOGUE: readonly CatalogueEntry[] = FORMAT_CHOICES.flatMap((choice): CatalogueEntry[] => {
	switch (choice.family) {
		case "zip":
			return ZIP_METHODS.map(method => ({ choice: choice.id, method, probe: probeFormat(choice.id, method) }))
		case "sevenZ":
			return SEVENZ_METHODS.map(method => ({ choice: choice.id, method, probe: probeFormat(choice.id, method) }))
		default:
			return [{ choice: choice.id, method: null, probe: probeFormat(choice.id) }]
	}
})

function catalogueKey(choice: FormatChoiceId, method: ZipMethodId | SevenZMethodId | null): string {
	return `${choice}:${method ?? ""}`
}

export type FormatInfoLookup = (choice: FormatChoiceId, method: ZipMethodId | SevenZMethodId | null) => ArchiveFormatInfo | undefined

// `infos` answers CATALOGUE in order.
export function catalogueLookup(infos: readonly ArchiveFormatInfo[]): FormatInfoLookup {
	const byKey = new Map<string, ArchiveFormatInfo>()

	for (const [index, entry] of CATALOGUE.entries()) {
		const info = infos[index]

		if (info !== undefined) {
			byKey.set(catalogueKey(entry.choice, entry.method), info)
		}
	}

	return (choice, method) => byKey.get(catalogueKey(choice, method))
}

export type CompressDialogAction =
	| { type: "setBase"; value: string }
	| { type: "setChoice"; choice: FormatChoiceId }
	| { type: "setLevel"; level: number }
	| { type: "setZipMethod"; method: ZipMethodId }
	| { type: "setSevenZMethod"; method: SevenZMethodId }
	| { type: "setSolid"; value: boolean }
	| { type: "setAes"; value: AesStrength }
	| { type: "setEncryptNames"; value: boolean }
	| { type: "setProtect"; value: boolean }
	| { type: "setPassword"; value: string }
	| { type: "setConfirm"; value: string }
	| { type: "toggleReveal" }
	| { type: "setAfterwards"; value: AfterwardsValue }
	| { type: "setDestination"; destination: JobDestination }
	| { type: "toggleAdvanced" }
	// `valid` is the validation of the state the submit saw; the reducer stays free of format infos.
	| { type: "requestSubmit"; valid: boolean }
	| { type: "cancelDelete" }

// The method whose levels and memory apply: zip's and 7z's own, none for the stream formats.
export function methodOf(state: Pick<CompressDialogState, "choice" | "zipMethod" | "sevenZMethod">): ZipMethodId | SevenZMethodId | null {
	switch (formatChoice(state.choice).family) {
		case "zip":
			return state.zipMethod
		case "sevenZ":
			return state.sevenZMethod
		default:
			return null
	}
}

export interface CompressDialogInit {
	prefs: CompressPreferences
	naming: NamingInput
	destination: JobDestination
	// Formats the selection can take; the remembered one falls back to the first when it can't.
	allowed: readonly FormatChoiceId[]
}

export function initCompressDialog({ prefs, naming, destination, allowed }: CompressDialogInit): CompressDialogState {
	const choice = allowed.includes(prefs.format) ? prefs.format : (allowed[0] ?? "zip")
	const levels: Partial<Record<FormatChoiceId, number>> = {}

	for (const { id } of FORMAT_CHOICES) {
		const level = presetOptions(prefs, id).level

		if (level !== null) {
			levels[id] = level
		}
	}

	const options = presetOptions(prefs, choice)

	return {
		step: "edit",
		naming,
		base: defaultArchiveBaseName(naming.entries, choice, naming.parentName, naming.fallback),
		nameEdited: false,
		choice,
		levels,
		zipMethod: options.zipMethod,
		sevenZMethod: options.sevenZMethod,
		solid: options.solid,
		aes: options.aes,
		encryptNames: options.encryptNames,
		protect: false,
		password: "",
		confirm: "",
		reveal: false,
		afterwards: "keep",
		destination,
		advancedOpen: false,
		submitAttempted: false
	}
}

export function compressDialogReducer(state: CompressDialogState, action: CompressDialogAction): CompressDialogState {
	switch (action.type) {
		case "setBase":
			return { ...state, base: action.value, nameEdited: true }
		case "setChoice":
			// The name follows the format until edited: a single compressed file keeps the file's full
			// name, the others drop its extension.
			return {
				...state,
				choice: action.choice,
				base: state.nameEdited
					? state.base
					: defaultArchiveBaseName(state.naming.entries, action.choice, state.naming.parentName, state.naming.fallback)
			}
		case "setLevel":
			return { ...state, levels: { ...state.levels, [state.choice]: action.level } }
		case "setZipMethod":
			return { ...state, zipMethod: action.method }
		case "setSevenZMethod":
			return { ...state, sevenZMethod: action.method }
		case "setSolid":
			return { ...state, solid: action.value }
		case "setAes":
			return { ...state, aes: action.value }
		case "setEncryptNames":
			return { ...state, encryptNames: action.value }
		case "setProtect":
			return { ...state, protect: action.value }
		case "setPassword":
			return { ...state, password: action.value }
		case "setConfirm":
			return { ...state, confirm: action.value }
		case "toggleReveal":
			return { ...state, reveal: !state.reveal }
		case "setAfterwards":
			return { ...state, afterwards: action.value }
		case "setDestination":
			return { ...state, destination: action.destination }
		case "toggleAdvanced":
			return { ...state, advancedOpen: !state.advancedOpen }
		case "requestSubmit":
			return {
				...state,
				submitAttempted: true,
				step: action.valid && state.afterwards === "deletePermanently" ? "confirmDelete" : state.step
			}
		case "cancelDelete":
			return { ...state, step: "edit" }
	}
}

export interface CompressErrors {
	// Why the SDK refuses the name ("Empty" for no base name at all); "otherFormat": it reads the name as
	// another format and refuses it; "pending": not asked yet.
	name?: EntryNameErrorKindJS | "otherFormat" | "pending"
	format?: "unavailable" | "needsOneFile"
	password?: ArchivePasswordProblem
	confirm?: "mismatch"
	dispose?: "notAllowed"
}

export interface CompressStart {
	name: string
	format: CompressFormat
	encrypted: boolean
	dispose: SourceDisposalKind | null
	// Only when encrypted.
	password: string | undefined
	// What the preferences remember; never the password, the disposal or the destination.
	prefs: { choice: FormatChoiceId; options: FormatOptions }
}

export type CompressValidation = { ok: true; start: CompressStart } | { ok: false; errors: CompressErrors }

export interface CompressValidationContext {
	// The format's info for a method; undefined when the catalogue lacks it.
	infoFor: FormatInfoLookup
	singleFile: boolean
	disposeAllowed: boolean
	// Why the SDK refuses compressNameToCheck's name (null: it takes it); undefined until answered.
	nameError: EntryNameErrorKindJS | null | undefined
	// What the SDK reads that name as, asked only for a single-file format; undefined until answered.
	nameFormat?: ArchiveFormat | null | undefined
}

// A single compressed file keeps its whole name and takes the extension on top (`x.gz` → `x.gz.gz`)
// until the name is edited; a typed name already ending in it does not get it twice.
export function compressArchiveName(state: Pick<CompressDialogState, "base" | "nameEdited" | "choice">, extension: string): string {
	return formatChoice(state.choice).family === "single" && !state.nameEdited
		? `${state.base.trim()}${extension}`
		: composeArchiveName(state.base, extension)
}

// The archive's name the SDK has to take as an item's; for a single-file format also as that format,
// whose extension can end another format's (`backup.tar` + `.gz` reads as a tarball), which it refuses.
// Null without a base name or the format's extension.
export function compressNameToCheck(state: CompressDialogState, infoFor: FormatInfoLookup): string | null {
	if (state.base.trim().length === 0) {
		return null
	}

	const info = infoFor(state.choice, methodOf(state))

	return info === undefined ? null : compressArchiveName(state, info.extension)
}

export function validateCompress(state: CompressDialogState, ctx: CompressValidationContext): CompressValidation {
	const choice = formatChoice(state.choice)
	const info = ctx.infoFor(state.choice, methodOf(state))
	const errors: CompressErrors = {}
	const base = state.base.trim()
	const encrypted = state.protect && choice.encryptable
	let name = ""

	if (info === undefined || !isFormatRunnable(info)) {
		errors.format = "unavailable"
	} else if (choice.group === "single" && !ctx.singleFile) {
		errors.format = "needsOneFile"
	}

	if (base.length === 0) {
		errors.name = "Empty"
	} else if (info !== undefined) {
		name = compressArchiveName(state, info.extension)

		if (ctx.nameError === undefined) {
			errors.name = "pending"
		} else if (ctx.nameError !== null) {
			errors.name = ctx.nameError
		} else if (choice.family === "single" && errors.format === undefined) {
			if (ctx.nameFormat === undefined) {
				errors.name = "pending"
			} else if (ctx.nameFormat?.type !== "single" || ctx.nameFormat.codec !== choice.codec) {
				errors.name = "otherFormat"
			}
		}
	}

	const passwordProblem = encrypted ? archivePasswordProblem(state.password) : null

	if (passwordProblem !== null) {
		errors.password = passwordProblem
	}

	if (encrypted && state.password !== state.confirm) {
		errors.confirm = "mismatch"
	}

	if (state.afterwards !== "keep" && !ctx.disposeAllowed) {
		errors.dispose = "notAllowed"
	}

	if (info === undefined || Object.keys(errors).length > 0) {
		return { ok: false, errors }
	}

	const options: FormatOptions = {
		// Never above what the budget runs, whatever was remembered or picked.
		level: effectiveLevel(info, state.levels[state.choice] ?? null),
		zipMethod: state.zipMethod,
		sevenZMethod: state.sevenZMethod,
		solid: state.solid,
		aes: state.aes,
		encryptNames: state.encryptNames
	}

	return {
		ok: true,
		start: {
			name,
			format: buildCompressFormat(state.choice, options, encrypted),
			encrypted,
			dispose: state.afterwards === "keep" ? null : state.afterwards,
			password: encrypted ? state.password : undefined,
			prefs: { choice: state.choice, options }
		}
	}
}

// The errors worth showing yet: an empty password or a mismatch only once the user typed a confirmation
// or tried to submit, so an untouched form isn't red.
export function visibleCompressErrors(state: CompressDialogState, errors: CompressErrors): CompressErrors {
	const visible: CompressErrors = { ...errors }

	if (visible.name === "pending") {
		delete visible.name
	}

	if (!state.submitAttempted) {
		if (visible.password === "empty") {
			delete visible.password
		}

		if (state.confirm.length === 0) {
			delete visible.confirm
		}
	}

	return visible
}
