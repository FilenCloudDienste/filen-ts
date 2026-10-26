import type { DesktopSyncLocalRootChoice, DesktopSyncMode, DesktopSyncNewPair } from "@filen/shared/desktop"
import { DOT_FILEN_DIR_NAME } from "@/lib/dotFilen.logic"
import type { SyncKey } from "@/lib/i18n"
import { ROOT_PROBLEM_KEY, ROOT_WARNING_KEY } from "@/features/sync/lib/syncErrors.logic"
import { pathBasename } from "@/features/sync/lib/syncStatus.logic"

// The steps before the pair exists; once addPair answered the dialog shows the review card instead.
export type AddPairStep = "local" | "remote" | "mode" | "name"

export const ADD_PAIR_STEPS: readonly AddPairStep[] = ["local", "remote", "mode", "name"]

export type LocalChoice = Extract<DesktopSyncLocalRootChoice, { status: "ok" }>

export interface AddPairForm {
	local: LocalChoice | null
	remote: string | null
	mode: DesktopSyncMode
	name: string
}

export const INITIAL_ADD_PAIR_FORM: AddPairForm = { local: null, remote: null, mode: "twoWay", name: "" }

// What the local step shows for a choice: a refusal blocks it, warnings never do.
export type LocalChoiceOutcome =
	{ kind: "canceled" } | { kind: "refused"; path: string; key: SyncKey } | { kind: "ok"; choice: LocalChoice; warningKeys: SyncKey[] }

export function localChoiceOutcome(choice: DesktopSyncLocalRootChoice): LocalChoiceOutcome {
	switch (choice.status) {
		case "canceled":
			return { kind: "canceled" }
		case "refused":
			return { kind: "refused", path: choice.path, key: ROOT_PROBLEM_KEY[choice.problem] }
		case "ok":
			return { kind: "ok", choice, warningKeys: choice.warnings.map(warning => ROOT_WARNING_KEY[warning]) }
	}
}

// The remote pick: the directory open in the chooser. The account's root is never one (the engine cannot sync
// it), so the top level picks nothing.
export function remotePick(openUuid: string | null, accountRootUuid: string | undefined): string | null {
	if (openUuid === null || openUuid.length === 0 || openUuid === accountRootUuid) {
		return null
	}

	return openUuid
}

export function defaultPairName(choice: LocalChoice): string {
	const name = choice.name.trim()

	return name.length > 0 ? name : pathBasename(choice.path)
}

export function canAdvance(step: AddPairStep, form: AddPairForm): boolean {
	switch (step) {
		case "local":
			return form.local !== null
		case "remote":
			return form.local !== null && form.remote !== null
		case "mode":
			return form.local !== null && form.remote !== null
		case "name":
			return form.local !== null && form.remote !== null && form.name.trim().length > 0
	}
}

export function nextStep(step: AddPairStep): AddPairStep | null {
	return ADD_PAIR_STEPS[ADD_PAIR_STEPS.indexOf(step) + 1] ?? null
}

export function previousStep(step: AddPairStep): AddPairStep | null {
	const index = ADD_PAIR_STEPS.indexOf(step)

	return index > 0 ? (ADD_PAIR_STEPS[index - 1] ?? null) : null
}

// The new pair as addPair takes it; null until every step is filled in.
export function addPairRequest(form: AddPairForm): DesktopSyncNewPair | null {
	if (form.local === null || form.remote === null || form.name.trim().length === 0) {
		return null
	}

	return { localRootId: form.local.id, remoteRoot: form.remote, mode: form.mode, name: form.name.trim() }
}

// A newly chosen local directory names the pair unless the user already typed a name of their own.
export function withLocalChoice(form: AddPairForm, choice: LocalChoice): AddPairForm {
	const previousDefault = form.local === null ? "" : defaultPairName(form.local)
	const keepName = form.name.trim().length > 0 && form.name !== previousDefault

	return { ...form, local: choice, name: keepName ? form.name : defaultPairName(choice) }
}

// The drive's own `.filen` directory at the top level: the app's data, never a sync root.
export function isHiddenRemoteRow(name: string, atDriveRoot: boolean): boolean {
	return atDriveRoot && name === DOT_FILEN_DIR_NAME
}
