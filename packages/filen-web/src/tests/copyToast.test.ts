import { describe, expect, it, vi } from "vitest"
import { QueryClient } from "@tanstack/react-query"
import type { ExternalToast } from "sonner"

const { toastCustom, copyItems } = vi.hoisted(() => ({
	toastCustom: vi.fn<(jsx: (id: string | number) => unknown, data?: ExternalToast) => string | number>(),
	copyItems: vi.fn(() => new Promise(() => undefined))
}))

vi.mock("sonner", () => ({ toast: { custom: toastCustom, dismiss: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock("@/lib/sdk/client", () => ({ sdkApi: { copyItems } }))
vi.mock("@/queries/client", () => ({ queryClient: new QueryClient() }))

import { startCopyWithCard } from "@/features/transfers/lib/copyToast"
import { narrowItem } from "@/features/drive/lib/item"
import { getCopyJob } from "@/features/transfers/store/useDriveJobsStore"

const DESTINATION = { uuid: null, name: "My Drive" }

describe("copy toast", () => {
	it("starts a copy with its card already showing", () => {
		const id = startCopyWithCard(
			[
				narrowItem({
					uuid: "f-0000-0000-0000-000000000000",
					parent: "p-0000-0000-0000-000000000000",
					color: "default",
					timestamp: 0n,
					favorited: false,
					meta: { type: "decoded", data: { name: "dir" } }
				})
			],
			DESTINATION
		)

		expect(id).not.toBeNull()
		expect(getCopyJob(id ?? "")?.cardVisible).toBe(true)
		expect(toastCustom.mock.calls.at(-1)?.[1]?.id).toMatch(new RegExp(`^copy:${id ?? ""}:\\d+$`))
		expect(startCopyWithCard([], DESTINATION)).toBeNull()
	})
})
