// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { act, cleanup, render } from "@testing-library/react"
import { TransfersUnloadGuard } from "@/features/shell/components/transfersUnloadGuard"
import { useTransfersStore, type Transfer } from "@/features/transfers/store/useTransfersStore"
import { consumeUnloadAllowance } from "@/lib/unloadGuard"

function transfer(overrides: Partial<Transfer> = {}): Transfer {
	return {
		id: "t1",
		direction: "upload",
		name: "report.pdf",
		size: 100,
		bytesTransferred: 0,
		status: "uploading",
		paused: false,
		parentUuid: null,
		startedAt: 0,
		...overrides
	}
}

// Whether a beforeunload dispatched now would make the browser ask before leaving.
function unloadIsBlocked(): boolean {
	const event = new Event("beforeunload", { cancelable: true })

	window.dispatchEvent(event)

	return event.defaultPrevented
}

beforeEach(() => {
	useTransfersStore.setState({ transfers: [], speedSamples: [] })
	consumeUnloadAllowance()
})

afterEach(() => {
	cleanup()
})

describe("TransfersUnloadGuard", () => {
	it("leaves the tab free to close while nothing is running", () => {
		render(<TransfersUnloadGuard />)

		expect(unloadIsBlocked()).toBe(false)
	})

	it.each(["uploading", "downloading", "copying"] as const)("asks before leaving while a transfer is %s", status => {
		render(<TransfersUnloadGuard />)

		act(() => {
			useTransfersStore.setState({ transfers: [transfer({ status })] })
		})

		expect(unloadIsBlocked()).toBe(true)
	})

	it("stops asking once every transfer has finished", () => {
		useTransfersStore.setState({ transfers: [transfer()] })
		render(<TransfersUnloadGuard />)

		act(() => {
			useTransfersStore.setState({ transfers: [transfer({ status: "done" }), transfer({ id: "t2", status: "completedWithErrors" })] })
		})

		expect(unloadIsBlocked()).toBe(false)
	})

	it("stops listening when unmounted", () => {
		useTransfersStore.setState({ transfers: [transfer()] })

		const { unmount } = render(<TransfersUnloadGuard />)

		unmount()

		expect(unloadIsBlocked()).toBe(false)
	})
})
