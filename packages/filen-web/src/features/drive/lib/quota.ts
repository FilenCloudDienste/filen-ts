import { toast } from "sonner"
import type { UserInfo } from "@filen/sdk-rs"
import { formatBytes, resolveQuotaVerdict, type QuotaCheckDeps, type QuotaVerdict } from "@filen/shared"
import { i18n } from "@/lib/i18n"
import { queryClient } from "@/queries/client"
import { ACCOUNT_QUERY_KEY, accountQueryUpdate, fetchAccountFresh } from "@/queries/account"

// The fresh read also refreshes every other account consumer, unless the account was written meanwhile.
export const accountQuotaDeps: QuotaCheckDeps = {
	cached: () => queryClient.getQueryData<UserInfo>(ACCOUNT_QUERY_KEY),
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

// Lets the next pre-flight see this upload without a read. accountQueryUpdate keeps a pending refresh
// pending, so the server's own figure still replaces this estimate on the next read.
export function addAccountStorageUsed(bytes: bigint): void {
	accountQueryUpdate(prev => ({ ...prev, storageUsed: prev.storageUsed + bytes }))
}
