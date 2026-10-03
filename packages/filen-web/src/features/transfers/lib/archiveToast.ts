import { showJobToast } from "@/features/transfers/lib/jobToast"
import { startCompress, startExtract } from "@/features/drive/lib/archiveJobs"
import type { CompressJobRequest, ExtractJobRequest } from "@/features/drive/lib/archiveJobs.logic"

// Every compress and extract the user starts shows its card, as a copy does (copyToast.tsx).

export function startCompressWithCard(request: Omit<CompressJobRequest, "id">, password: string | undefined): string {
	const id = startCompress(request, password)

	showJobToast(id)

	return id
}

export function startExtractWithCard(request: Omit<ExtractJobRequest, "id">, password: string | undefined): string {
	const id = startExtract(request, password)

	showJobToast(id)

	return id
}
