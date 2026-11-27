// How far linking or sharing a directory is: first its tree is read (bytes listed, of a total the SDK may not
// know yet), then its items are linked or shared one by one (the directory itself counted).
export type DirectoryProgress = { phase: "reading"; fraction: number | undefined } | { phase: "items"; done: number; total: number }

export interface DirectoryProgressCallbacks {
	// The listing's (downloaded, total) bytes.
	bytes: (downloadedBytes: number, totalBytes: number | undefined) => void
	// (done, total) items: (0, total) once the listing is in, then after each item.
	items: (done: number, total: number) => void
}

// The two SDK callbacks as one phase stream. They cross on separate message ports, so a byte report that
// lands after the first item report is dropped rather than taking the phase back.
export function directoryProgress(report: (progress: DirectoryProgress) => void): DirectoryProgressCallbacks {
	let listed = false

	return {
		bytes: (downloadedBytes, totalBytes) => {
			if (listed) {
				return
			}

			report({
				phase: "reading",
				fraction: totalBytes !== undefined && totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : undefined
			})
		},
		items: (done, total) => {
			listed = true

			report({ phase: "items", done, total })
		}
	}
}

// 0-1 for a bar, or undefined while the listing's size is unknown (an indeterminate bar).
export function directoryProgressFraction(progress: DirectoryProgress): number | undefined {
	if (progress.phase === "reading") {
		return progress.fraction
	}

	return progress.total > 0 ? Math.min(1, progress.done / progress.total) : undefined
}
