import { toast } from "sonner"
import { i18n } from "@/lib/i18n"
import { holdUnload } from "@/lib/unloadGuard"
import { withoutKey } from "@/lib/utils"
import { runBulkOutcomes } from "@/lib/actions/bulk"
import { RESULT_TOAST_MS, RESULT_TOAST_WITH_PROBLEMS_MS } from "@/lib/toastDurations"
import type { BulkOutcome, BulkProgress } from "@/lib/actions/bulk"
import { useActivityStore } from "@/lib/activity/activityStore"
import type { VoidActionOutcome } from "@/lib/actions/outcome"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { TOAST_ICONS } from "@/components/ui/toastIcons"
import { ActivityProgressLine } from "@/lib/activity/activityProgressLine"
import {
	bulkResult,
	runningLine,
	type ActivityFailure,
	type ActivityKeys,
	type ActivityLine,
	type ActivityProgress,
	type ActivityValues
} from "@/lib/activity/activity.logic"

// A server write the user waits on, shown as a toast for as long as it runs and turned into its result
// in place when it ends. Transfers have their own surfaces; this is everything else (moves, trash,
// favorites, shares, ...). The toast can be hidden while it runs (the work goes on and its result still
// shows), and closing the tab meanwhile asks first: a half-done bulk run cannot resume.

let activities = 0

function text(line: ActivityLine): string {
	return i18n.t(line.key, line.values)
}

export interface ActivityResult {
	tone: "success" | "error"
	title: string
	// One failure's reason, under the title.
	description?: string
	// Several failures, listed in a dialog the toast's Details opens.
	failures?: ActivityFailure[]
	retry?: () => void
}

interface ActivitySpec<R> {
	label: string
	// False when something on screen already shows the work running (a dialog's own spinner): only the
	// result toasts.
	showRunning?: boolean
	run: (report: (progress: ActivityProgress) => void) => Promise<R>
	// Null: nothing to report.
	result: (value: R) => ActivityResult | null
}

function showResult(id: string, hidden: boolean, result: ActivityResult): void {
	const failures = result.failures !== undefined && result.failures.length > 1 ? result.failures : undefined
	const options = {
		// A hidden toast is on its way out, and one issued under its id would leave with it.
		...(hidden ? {} : { id }),
		icon: TOAST_ICONS[result.tone],
		description: result.description,
		duration: result.tone === "success" ? RESULT_TOAST_MS : RESULT_TOAST_WITH_PROBLEMS_MS,
		...(result.retry === undefined ? {} : { action: { label: i18n.t("common:tryAgain"), onClick: result.retry } }),
		...(failures === undefined
			? {}
			: {
					cancel: {
						label: i18n.t("common:activityDetails"),
						onClick: () => {
							useActivityStore.setState({ details: { title: result.title, failures } })
						}
					}
				})
	}

	if (result.tone === "success") {
		toast.success(result.title, options)
	} else {
		toast.error(result.title, options)
	}
}

export async function runActivity<R>({ label, showRunning = true, run, result }: ActivitySpec<R>): Promise<R> {
	activities += 1

	const id = `activity:${String(activities)}`
	// Hidden from its ✕ while running, the result then shows as a toast of its own. An object: the toast's
	// dismiss handler writes it after this function last read it.
	const toastState = { hidden: false, settled: false }

	function report(progress: ActivityProgress): void {
		useActivityStore.setState(state => ({ progress: { ...state.progress, [id]: progress } }))
	}

	const release = holdUnload()

	try {
		if (showRunning) {
			toast(label, {
				id,
				icon: TOAST_ICONS.loading,
				duration: Infinity,
				description: <ActivityProgressLine id={id} />,
				onDismiss: () => {
					toastState.hidden ||= !toastState.settled
				}
			})
		}

		const value = await run(report)
		const outcome = result(value)

		toastState.settled = true

		if (outcome === null) {
			toast.dismiss(id)
		} else {
			showResult(id, toastState.hidden || !showRunning, outcome)
		}

		return value
	} catch (e) {
		toastState.settled = true
		showResult(id, toastState.hidden || !showRunning, { tone: "error", title: label, description: errorLabel(e) })

		throw e
	} finally {
		release()
		useActivityStore.setState(state => ({ progress: withoutKey(state.progress, id) }))
	}
}

export interface BulkActivitySpec<T> {
	items: readonly T[]
	keys: ActivityKeys
	name: (item: T) => string
	values?: ActivityValues
	// `report` for a run that measures its progress otherwise than by items settled (a directory share's
	// bytes).
	run: (items: T[], onSettled: BulkProgress, report: (progress: ActivityProgress) => void) => Promise<BulkOutcome<T>>
	// What follows the run in the caller (pruning a selection), before its result shows.
	onDone?: (outcome: BulkOutcome<T>) => void
	showRunning?: boolean
}

// A run over items, each settling on its own: the toast counts them as they settle, then says how many
// succeeded and, for any that failed, why, with Try again re-running only the failed ones.
export function runBulkActivity<T>(spec: BulkActivitySpec<T>): Promise<BulkOutcome<T>> {
	const { items, keys, name, values, run, onDone, showRunning } = spec
	const label = text(runningLine(keys, items, name, values))

	return runActivity({
		label,
		...(showRunning !== undefined ? { showRunning } : {}),
		// Never rejects: a run that throws instead of settling its items (a worker gone) fails them all, so
		// the toast offers Try again and a caller's pending state always clears after the await.
		run: async report => {
			try {
				return await run(
					[...items],
					(settled, total) => {
						report({ kind: "count", settled, total })
					},
					report
				)
			} catch (error) {
				return { succeeded: [], failed: items.map(item => ({ item, error })) }
			}
		},
		result: outcome => {
			onDone?.(outcome)

			const summary = bulkResult(keys, outcome, name, values)

			if (summary === null) {
				return null
			}

			const [onlyFailure] = summary.failures
			const failedItems = outcome.failed.map(failure => failure.item)

			return {
				tone: summary.tone,
				title: text(summary.line),
				...(summary.failures.length === 1 && onlyFailure !== undefined ? { description: errorLabel(onlyFailure.error) } : {}),
				failures: summary.failures,
				...(failedItems.length > 0
					? {
							retry: () => {
								void runBulkActivity({ ...spec, items: failedItems, showRunning: true })
							}
						}
					: {})
			}
		}
	})
}

// One write on one subject (favoriting an item, muting a chat), in the same words and with the same
// result as a bulk run of one.
export function runOutcomeActivity<T>(
	subject: T,
	spec: Omit<BulkActivitySpec<T>, "items" | "run"> & { run: (subject: T) => Promise<VoidActionOutcome> }
): Promise<BulkOutcome<T>> {
	const { run, ...rest } = spec

	return runBulkActivity({ ...rest, items: [subject], run: (items, onSettled) => runBulkOutcomes(items, run, onSettled) })
}
