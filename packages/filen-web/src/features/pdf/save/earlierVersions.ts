import { toast } from "sonner"
import type { FileVersion } from "@filen/sdk-rs"
import { deleteVersions, type FileItem } from "@/features/drive/lib/actions"
import { DRIVE_DELETE_VERSIONS } from "@/features/drive/lib/activity"
import { nonCurrentVersions } from "@/features/drive/components/versionsDialog.logic"
import { fetchFileVersions, fileVersionsQueryKey } from "@/features/drive/queries/drive"
import { runBulkActivity } from "@/lib/activity/activity"
import { runOp } from "@/lib/actions/outcome"
import { formatDateTime } from "@/lib/formatDate"
import { errorLabel } from "@/lib/i18n/errorLabel"
import { queryClient } from "@/queries/client"

// Deletes every version of `file` but the live one, as the versions panel's Delete all does (one activity toast with
// the result, the panel's cached list pruned). The list is read fresh: the save that asks for this just added a
// version. False when the list could not be read (a toast says why).
export async function deleteEarlierVersions(file: FileItem): Promise<boolean> {
	let versions: FileVersion[]

	try {
		versions = await runOp(
			queryClient.query({
				queryKey: fileVersionsQueryKey(file.data.uuid),
				queryFn: () => fetchFileVersions(file.data),
				staleTime: 0
			})
		)
	} catch (e) {
		toast.error(errorLabel(e))

		return false
	}

	const targets = nonCurrentVersions(versions, file)

	if (targets.length === 0) {
		return true
	}

	await runBulkActivity({
		items: targets,
		keys: DRIVE_DELETE_VERSIONS,
		name: version => formatDateTime(version.timestamp),
		run: (items, onSettled) => deleteVersions(file, items, onSettled),
		onDone: outcome => {
			const succeeded = new Set<string>(outcome.succeeded.map(version => version.uuid))

			queryClient.setQueryData<FileVersion[]>(fileVersionsQueryKey(file.data.uuid), prev =>
				prev?.filter(existing => !succeeded.has(existing.uuid))
			)
		},
		// The asking dialog's spinner shows the run, so only its result toasts.
		showRunning: false
	})

	return true
}
