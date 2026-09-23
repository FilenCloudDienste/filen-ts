import { create } from "zustand"
import { type CopyJob } from "@/features/drive/lib/copy.logic"

// The detail behind each copy job's single transfers row, keyed by the same id. In memory only, like
// useTransfersStore: a copy doesn't outlive the tab that runs it.
export interface CopyJobsStore {
	jobs: Record<string, CopyJob>
	put: (job: CopyJob) => void
	// A no-op for an id that is already gone, so a late callback can't resurrect a pruned job.
	update: (id: string, updater: (job: CopyJob) => CopyJob) => void
	remove: (id: string) => void
}

export const useCopyJobsStore = create<CopyJobsStore>(set => ({
	jobs: {},
	put: job => {
		set(state => ({ jobs: { ...state.jobs, [job.id]: job } }))
	},
	update: (id, updater) => {
		set(state => {
			const job = state.jobs[id]

			return job === undefined ? state : { jobs: { ...state.jobs, [id]: updater(job) } }
		})
	},
	remove: id => {
		set(state => (id in state.jobs ? { jobs: Object.fromEntries(Object.entries(state.jobs).filter(([key]) => key !== id)) } : state))
	}
}))

export function getCopyJob(id: string): CopyJob | undefined {
	return useCopyJobsStore.getState().jobs[id]
}
