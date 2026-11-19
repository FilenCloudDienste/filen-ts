import { expect } from "vitest"
import { act, waitFor } from "@testing-library/react"
import type { QueryClient } from "@tanstack/react-query"

// Let a mounted screen settle: 20 real macrotask turns inside act (chained reads, debounces at 0, store
// writes), then wait until the client has no fetch in flight. Request-count suites count reads after it.
export async function drain(queryClient: QueryClient): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 20; i++) {
			await new Promise(resolve => setTimeout(resolve, 0))
		}
	})
	await waitFor(() => {
		expect(queryClient.isFetching()).toBe(0)
	})
}
