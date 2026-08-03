// @vitest-environment jsdom

// Two subjects, one file, because both need a DOM and the run is node-environment by default
// (vitest.config.ts): the useCapsLock hook itself, and the settings ChangePasswordCard render cases
// that prove the same hook + live-region contract on the settings side. The settings cases cannot
// live in changePassword.test.ts — that one is a node-environment logic test with no DOM.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render, renderHook, act, screen, cleanup, fireEvent } from "@testing-library/react"
import { createElement } from "react"
import "@/lib/i18n"
import type { AccountQuerySuccess } from "@/queries/account"
import { useCapsLock } from "@/features/auth/lib/useCapsLock"

const { changePassword } = vi.hoisted(() => ({ changePassword: vi.fn() }))

vi.mock("@/lib/sdk/client", () => ({ sdkApi: { changePassword } }))
vi.mock("@/lib/sdk/session", () => ({ persistSession: vi.fn(), clearSession: vi.fn(), broadcastAuth: vi.fn() }))

const { ChangePasswordCard } = await import("@/features/settings/components/security/changePassword")

// Only refetch() is ever read, and only on the success path these cases never reach.
const accountQuery = { refetch: vi.fn() } as unknown as AccountQuerySuccess

function capsEvent(on: boolean): { getModifierState: (key: "CapsLock") => boolean } {
	return { getModifierState: () => on }
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	cleanup()
})

describe("useCapsLock", () => {
	it("starts off — the state is unknowable until the user types", () => {
		const { result } = renderHook(() => useCapsLock())

		expect(result.current.capsLockOn).toBe(false)
	})

	it("turns on when a keydown reports the modifier", () => {
		const { result } = renderHook(() => useCapsLock())

		act(() => {
			result.current.onKeyDown(capsEvent(true))
		})

		expect(result.current.capsLockOn).toBe(true)
	})

	it("turns off on keyup — catches caps lock being toggled off mid-field", () => {
		const { result } = renderHook(() => useCapsLock())

		act(() => {
			result.current.onKeyDown(capsEvent(true))
		})
		act(() => {
			result.current.onKeyUp(capsEvent(false))
		})

		expect(result.current.capsLockOn).toBe(false)
	})

	it("clears on blur so the warning only ever sits under the focused field", () => {
		const { result } = renderHook(() => useCapsLock())

		act(() => {
			result.current.onKeyDown(capsEvent(true))
		})
		act(() => {
			result.current.onBlur()
		})

		expect(result.current.capsLockOn).toBe(false)
	})

	it("asks for the CapsLock modifier specifically, not whatever key was pressed", () => {
		const getModifierState = vi.fn(() => true)
		const { result } = renderHook(() => useCapsLock())

		act(() => {
			result.current.onKeyDown({ getModifierState })
		})

		expect(getModifierState).toHaveBeenCalledWith("CapsLock")
	})
})

describe("ChangePasswordCard — caps-lock warning", () => {
	it("surfaces the warning under the typed field and nowhere else", () => {
		render(createElement(ChangePasswordCard, { accountQuery }))

		fireEvent.keyDown(screen.getByLabelText("New password"), { key: "a", modifierCapsLock: true })

		expect(screen.getAllByText("Caps Lock is on")).toHaveLength(1)
	})

	it("clears the text on blur while the live region stays mounted", () => {
		render(createElement(ChangePasswordCard, { accountQuery }))

		const input = screen.getByLabelText("New password")
		fireEvent.keyDown(input, { key: "a", modifierCapsLock: true })
		fireEvent.blur(input)

		expect(screen.queryByText("Caps Lock is on")).toBeNull()
		// The region must pre-exist its content change or screen readers skip the announcement.
		expect(screen.getAllByRole("status").length).toBeGreaterThan(0)
	})
})
