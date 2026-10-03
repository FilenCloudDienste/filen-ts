import { create } from "zustand"
import { isJobRunning, type DriveJobKind } from "@filen/shared"
import type { CopyJob } from "@/features/drive/lib/copy.logic"
import type { DriveJob, DriveJobOf } from "@/features/drive/lib/driveJobs.logic"
import { withoutKey } from "@/lib/utils"

// The detail behind each drive job's (copy, compress, extract) single transfers row, keyed by the same
// id. In memory only, like useTransfersStore: a job doesn't outlive the tab that runs it. One store for
// every kind: nearly every reader looks a job up by id alone.
export interface DriveJobsStore {
	jobs: Readonly<Record<string, DriveJob>>
	// A running job replacing one under the same id (an extract rerun with its password) is a fresh run:
	// a stop prompt or report left open for the earlier run closes rather than carry over to it.
	put: (job: DriveJob) => void
	// A no-op for an id that is already gone, so a late callback can't resurrect a pruned job; for a job of
	// another kind; and for an updater that returns the job it was given, which notifies no one.
	update: <K extends DriveJobKind>(kind: K, id: string, updater: (job: DriveJobOf<K>) => DriveJobOf<K>) => void
	remove: (id: string) => void
	removeMany: (ids: ReadonlySet<string>) => void
	// The job the cancel prompt is open for, whichever surface asked (card or transfers row).
	cancelPromptId: string | null
	setCancelPromptId: (id: string | null) => void
	// The extract the password prompt is open for.
	passwordPromptId: string | null
	setPasswordPromptId: (id: string | null) => void
	// The job whose report is open.
	reportJobId: string | null
	setReportJobId: (id: string | null) => void
}

function isKind<K extends DriveJobKind>(job: DriveJob, kind: K): job is DriveJobOf<K> {
	return job.kind === kind
}

export const useDriveJobsStore = create<DriveJobsStore>(set => ({
	jobs: {},
	put: job => {
		set(state => {
			const next: Partial<DriveJobsStore> = { jobs: { ...state.jobs, [job.id]: job } }

			if (isJobRunning(job) && Object.hasOwn(state.jobs, job.id)) {
				if (state.cancelPromptId === job.id) {
					next.cancelPromptId = null
				}

				if (state.reportJobId === job.id) {
					next.reportJobId = null
				}
			}

			return next
		})
	},
	update: (kind, id, updater) => {
		set(state => {
			const job = state.jobs[id]

			if (job === undefined || !isKind(job, kind)) {
				return state
			}

			const next = updater(job)

			return next === job ? state : { jobs: { ...state.jobs, [id]: next } }
		})
	},
	remove: id => {
		set(state => {
			const jobs = withoutKey(state.jobs, id)

			return jobs === state.jobs ? state : { jobs }
		})
	},
	removeMany: ids => {
		set(state => {
			let jobs: Record<string, DriveJob> | undefined

			for (const id of ids) {
				if (Object.hasOwn(state.jobs, id)) {
					jobs ??= { ...state.jobs }

					Reflect.deleteProperty(jobs, id)
				}
			}

			return jobs === undefined ? state : { jobs }
		})
	},
	cancelPromptId: null,
	setCancelPromptId: id => {
		set({ cancelPromptId: id })
	},
	passwordPromptId: null,
	setPasswordPromptId: id => {
		set({ passwordPromptId: id })
	},
	reportJobId: null,
	setReportJobId: id => {
		set({ reportJobId: id })
	}
}))

export function getDriveJob(id: string): DriveJob | undefined {
	return useDriveJobsStore.getState().jobs[id]
}

export function getJobOf<K extends DriveJobKind>(kind: K, id: string): DriveJobOf<K> | undefined {
	const job = getDriveJob(id)

	return job !== undefined && isKind(job, kind) ? job : undefined
}

export function getCopyJob(id: string): CopyJob | undefined {
	return getJobOf("copy", id)
}

// One kind's view of the store, for the runner of that kind.
export interface JobsAccess<J> {
	put: (job: J) => void
	update: (id: string, updater: (job: J) => J) => void
	get: (id: string) => J | undefined
}

export function jobsAccess<K extends DriveJobKind>(kind: K): JobsAccess<DriveJobOf<K>> {
	return {
		put: job => {
			useDriveJobsStore.getState().put(job)
		},
		update: (id, updater) => {
			useDriveJobsStore.getState().update(kind, id, updater)
		},
		get: id => getJobOf(kind, id)
	}
}
