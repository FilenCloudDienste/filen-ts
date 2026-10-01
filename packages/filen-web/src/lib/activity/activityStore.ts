import { create } from "zustand"
import type { ActivityFailure, ActivityProgress } from "@/lib/activity/activity.logic"

interface ActivityStore {
	// Running activities' progress, read by their toast's progress line.
	progress: Readonly<Record<string, ActivityProgress>>
	// The failures the details dialog lists, while it is open.
	details: { title: string; failures: ActivityFailure[] } | null
}

export const useActivityStore = create<ActivityStore>(() => ({ progress: {}, details: null }))
