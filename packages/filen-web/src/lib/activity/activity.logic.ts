import type { AppKey } from "@/lib/i18n/appKey"
import type { BulkOutcome } from "@/lib/actions/bulk"

// The words of one kind of action, from the moment it starts to how it ended. Each key is plural: `_one`
// names the one item ({{name}}), `_other` counts them ({{count}}). Narrowed by naming convention, as
// i18n.t cannot type the options of a union of arbitrary keys.
export interface ActivityKeys {
	// "Moving report.pdf to trash" / "Moving 3 items to trash"
	running: Extract<AppKey, `${string}:${string}Running`>
	// "Moved report.pdf to trash" / "Moved 3 items to trash"
	done: Extract<AppKey, `${string}:${string}Done`>
	// Every item failed: "Couldn't move report.pdf to trash" / "Couldn't move 3 items to trash"
	failed: Extract<AppKey, `${string}:${string}Failed`>
	// Some failed: {{count}} succeeded, {{failed}} failed. "Moved 2 items to trash, 1 failed"
	partial: Extract<AppKey, `${string}:${string}Partial`>
}

// The prefixes with all four keys in the catalog ("drive:driveTrash" for driveTrashRunning, ...Done,
// ...Failed, ...Partial).
export type ActivityPrefix = {
	[K in AppKey]: K extends `${infer P}Running` ? (`${P}Done` | `${P}Failed` | `${P}Partial` extends AppKey ? P : never) : never
}[AppKey]

// An action's keys by the naming convention, so the four can never drift apart or be mistyped.
export function activityKeys(prefix: ActivityPrefix): ActivityKeys {
	return { running: `${prefix}Running`, done: `${prefix}Done`, failed: `${prefix}Failed`, partial: `${prefix}Partial` }
}

// Extra interpolation an action's words take besides the count and name (a move's destination).
export type ActivityValues = Readonly<Record<string, string>>

// How far along a running activity is: items settled of a bulk run, or a fraction of work (a directory
// share's bytes).
export type ActivityProgress = { kind: "count"; settled: number; total: number } | { kind: "fraction"; value: number }

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

export function runningLine<T>(keys: ActivityKeys, items: readonly T[], name: (item: T) => string, values?: ActivityValues): ActivityLine {
	const [first] = items

	return { key: keys.running, values: { ...values, count: items.length, name: first === undefined ? "" : name(first) } }
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
					line: { key: keys.done, values: { ...values, count: succeeded, name: first === undefined ? "" : name(first) } },
					failures
				}
	}

	if (succeeded === 0) {
		return { tone: "error", line: { key: keys.failed, values: { ...values, count: failed, name: failures[0]?.name ?? "" } }, failures }
	}

	return { tone: "error", line: { key: keys.partial, values: { ...values, count: succeeded, failed } }, failures }
}

// 0-100 for the toast's bar.
export function progressPercent(progress: ActivityProgress): number {
	if (progress.kind === "fraction") {
		return Math.min(100, Math.max(0, progress.value * 100))
	}

	return progress.total === 0 ? 0 : Math.min(100, (progress.settled / progress.total) * 100)
}

// Only a run of several items counts its items; one item has nothing to count.
export function showsProgress(progress: ActivityProgress | undefined): progress is ActivityProgress {
	return progress !== undefined && (progress.kind === "fraction" || progress.total > 1)
}
