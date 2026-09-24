import { create } from "zustand"
import type { CopyJob } from "@/features/copy/copyAdapter"

// A copy's detail (phase, counts, failures, what it created). Kept apart from the transfers row, which
// is closure- and handle-free by design; a settled job is dropped with its finished row.
export type CopyJobsStore = {
	jobs: Record<string, CopyJob>
	put: (job: CopyJob) => void
	update: (id: string, fn: (job: CopyJob) => CopyJob) => void
	remove: (id: string) => void
	clear: () => void
}

export const useCopyJobsStore = create<CopyJobsStore>(set => ({
	jobs: {},
	put(job) {
		set(state => ({
			jobs: {
				...state.jobs,
				[job.id]: job
			}
		}))
	},
	update(id, fn) {
		set(state => {
			const job = state.jobs[id]

			if (!job) {
				return state
			}

			return {
				jobs: {
					...state.jobs,
					[id]: fn(job)
				}
			}
		})
	},
	remove(id) {
		set(state => {
			if (!state.jobs[id]) {
				return state
			}

			const { [id]: _removed, ...jobs } = state.jobs

			return {
				jobs
			}
		})
	},
	clear() {
		set(state => (Object.keys(state.jobs).length === 0 ? state : { jobs: {} }))
	}
}))

export function getCopyJob(id: string): CopyJob | undefined {
	return useCopyJobsStore.getState().jobs[id]
}

export default useCopyJobsStore
