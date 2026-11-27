import type { AppKey } from "@/lib/i18n/appKey"
import type { BulkOutcome } from "@/lib/actions/bulk"

// The words of one kind of action, from the moment it starts to how it ended. A run of exactly one item
// takes the `Named` key ({{name}}); any other run the plural key ({{count}}). The plural `_one` is a CLDR
// category, not "one item": Russian and Ukrainian put 21, 31, 101 in it, so it always counts. Narrowed by
// naming convention, as i18n.t cannot type the options of a union of arbitrary keys.
export interface ActivityKeys {
	// "Moving report.pdf to trash"
	runningNamed: Extract<AppKey, `${string}:${string}RunningNamed`>
	// "Moving 3 items to trash"
	running: Extract<AppKey, `${string}:${string}Running`>
	// "Moved report.pdf to trash"
	doneNamed: Extract<AppKey, `${string}:${string}DoneNamed`>
	// "Moved 3 items to trash"
	done: Extract<AppKey, `${string}:${string}Done`>
	// Every item failed: "Couldn't move report.pdf to trash"
	failedNamed: Extract<AppKey, `${string}:${string}FailedNamed`>
	// Every item failed: "Couldn't move 3 items to trash"
	failed: Extract<AppKey, `${string}:${string}Failed`>
	// Some failed: {{count}} succeeded, {{failed}} failed. "Moved 2 items to trash, 1 failed"
	partial: Extract<AppKey, `${string}:${string}Partial`>
}

// The prefixes with all seven keys in the catalog ("drive:driveTrash" for driveTrashRunning,
// driveTrashRunningNamed, ...Done, ...Failed, ...Partial).
export type ActivityPrefix = {
	[K in AppKey]: K extends `${infer P}Running`
		? `${P}RunningNamed` | `${P}Done` | `${P}DoneNamed` | `${P}Failed` | `${P}FailedNamed` | `${P}Partial` extends AppKey
			? P
			: never
		: never
}[AppKey]

// An action's keys by the naming convention, so the seven can never drift apart or be mistyped.
export function activityKeys(prefix: ActivityPrefix): ActivityKeys {
	return {
		runningNamed: `${prefix}RunningNamed`,
		running: `${prefix}Running`,
		doneNamed: `${prefix}DoneNamed`,
		done: `${prefix}Done`,
		failedNamed: `${prefix}FailedNamed`,
		failed: `${prefix}Failed`,
		partial: `${prefix}Partial`
	}
}

// Extra interpolation an action's words take besides the count and name (a move's destination).
export type ActivityValues = Readonly<Record<string, string>>

// How far along a running activity is: items settled of a bulk run, a fraction of work, or a phase the run
// words itself ("Reading directory…"), with a fraction or none yet (an indeterminate bar).
export type ActivityProgress =
	| { kind: "count"; settled: number; total: number }
	| { kind: "fraction"; value: number }
	| { kind: "phase"; label: string; value: number | undefined }

export interface ActivityLine {
	key: ActivityKeys[keyof ActivityKeys]
	values: Record<string, string | number>
}

export interface ActivityFailure {
	name: string
	error: unknown
}

export interface BulkResult {
	tone: "success" | "error"
	line: ActivityLine
	failures: ActivityFailure[]
}

// One item is named, any other number counted.
function countOrNamed(
	named: ActivityKeys[keyof ActivityKeys],
	counted: ActivityKeys[keyof ActivityKeys],
	count: number,
	name: string | undefined,
	values: ActivityValues | undefined
): ActivityLine {
	return count === 1 && name !== undefined ? { key: named, values: { ...values, name } } : { key: counted, values: { ...values, count } }
}

export function runningLine<T>(keys: ActivityKeys, items: readonly T[], name: (item: T) => string, values?: ActivityValues): ActivityLine {
	const [first] = items

	return countOrNamed(keys.runningNamed, keys.running, items.length, first === undefined ? undefined : name(first), values)
}

// What a bulk run's result toast says. Null when nothing ran (an empty selection): nothing to report.
export function bulkResult<T>(
	keys: ActivityKeys,
	outcome: BulkOutcome<T>,
	name: (item: T) => string,
	values?: ActivityValues
): BulkResult | null {
	const succeeded = outcome.succeeded.length
	const failed = outcome.failed.length
	const failures = outcome.failed.map(failure => ({ name: name(failure.item), error: failure.error }))

	if (failed === 0) {
		const [first] = outcome.succeeded

		return succeeded === 0
			? null
			: {
					tone: "success",
					line: countOrNamed(keys.doneNamed, keys.done, succeeded, first === undefined ? undefined : name(first), values),
					failures
				}
	}

	if (succeeded === 0) {
		return { tone: "error", line: countOrNamed(keys.failedNamed, keys.failed, failed, failures[0]?.name, values), failures }
	}

	return { tone: "error", line: { key: keys.partial, values: { ...values, count: succeeded, failed } }, failures }
}

// 0-100 for the toast's bar; null for an indeterminate one.
export function progressPercent(progress: ActivityProgress): number | null {
	if (progress.kind === "phase") {
		return progress.value === undefined ? null : Math.min(100, Math.max(0, progress.value * 100))
	}

	if (progress.kind === "fraction") {
		return Math.min(100, Math.max(0, progress.value * 100))
	}

	return progress.total === 0 ? 0 : Math.min(100, (progress.settled / progress.total) * 100)
}

// Only a run of several items counts its items; one item has nothing to count.
export function showsProgress(progress: ActivityProgress | undefined): progress is ActivityProgress {
	return progress !== undefined && (progress.kind !== "count" || progress.total > 1)
}
