import { toast } from "sonner"
import { formatBytes, resolveQuotaVerdict, type QuotaCheckDeps, type QuotaVerdict } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { accountQueryGet, accountQueryUpdate, fetchAccountFresh } from "@/queries/account"

// The fresh read also refreshes every other account consumer, unless the account was written meanwhile.
export const accountQuotaDeps: QuotaCheckDeps = {
	cached: accountQueryGet,
	fetchFresh: fetchAccountFresh
}

// Upload pre-flight against the cached account; see resolveQuotaVerdict for when it reads fresh.
export function checkUploadQuota(neededBytes: bigint): Promise<QuotaVerdict> {
	return resolveQuotaVerdict(accountQuotaDeps, neededBytes)
}

export function quotaExceededMessage(verdict: Extract<QuotaVerdict, { status: "exceeds" }>): string {
	return i18n.t("transfers:transfersQuotaExceeded", {
		needed: formatBytes(Number(verdict.neededBytes)),
		free: formatBytes(Number(verdict.freeBytes))
	})
}

// For entry points with no outcome of their own to carry the message: toasts it and returns false.
export async function ensureUploadQuota(neededBytes: bigint): Promise<boolean> {
	const verdict = await checkUploadQuota(neededBytes)

	if (verdict.status !== "exceeds") {
		return true
	}

	toast.error(quotaExceededMessage(verdict))

	return false
}

// Lets the next pre-flight see this upload without a read. The refresh markAccountStale queued stays
// pending for the next focus, mount or reconnect, so the server's own figure replaces this estimate then
// rather than with a read per file; readNow reads at once instead.
export function addAccountStorageUsed(bytes: bigint, options?: { readNow?: boolean }): void {
	accountQueryUpdate(prev => ({ ...prev, storageUsed: prev.storageUsed + bytes }), {
		readNow: options?.readNow ?? false
	})
}
