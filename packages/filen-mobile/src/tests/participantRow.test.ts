import { vi, describe, it, expect } from "vitest"

// ─── Module boundary mocks ───────────────────────────────────────────────────

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

// react-i18next — not needed for pure builder tests, but participantRow.tsx imports it at module level
vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (k: string) => k })
}))

// uniwind — participantRow.tsx imports useResolveClassNames
vi.mock("uniwind", () => ({
	useResolveClassNames: () => ({ color: "#fff" })
}))

// react-native-reanimated — imported by participantRow.tsx for animated view
vi.mock("react-native-reanimated", () => ({
	FadeIn: {},
	FadeOut: {}
}))

// UI components — not under test
vi.mock("@/components/ui/text", () => ({ default: () => null }))
vi.mock("@/components/ui/view", () => ({
	default: () => null,
	CrossGlassContainerView: () => null
}))
vi.mock("@/components/ui/pressables", () => ({ PressableScale: () => null }))
vi.mock("@/components/ui/avatar", () => ({ default: () => null }))
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: () => null }))
vi.mock("@/components/ui/animated", () => ({ AnimatedView: () => null }))
vi.mock("@/components/ui/menu", () => ({ default: () => null }))
vi.mock("@expo/vector-icons/Ionicons", () => ({ default: () => null }))
vi.mock("@/components/ui/listRow", () => ({ default: () => null, ListRowSectionHeader: () => null }))
vi.mock("@/components/ui/ellipsisMenuTrigger", () => ({ default: () => null }))

// ─── Actual imports ──────────────────────────────────────────────────────────

import { type TFunction } from "i18next"
import { buildParticipantMenuButtons, type ParticipantOwnerActions } from "@/components/participants/participantRow"
import type { MenuButton } from "@/components/ui/menu"

// ─── Helpers ─────────────────────────────────────────────────────────────────

const t = ((key: string) => key) as unknown as TFunction

function makeOwnerActions(overrides: Partial<ParticipantOwnerActions> = {}): ParticipantOwnerActions {
	return {
		isSelected: false,
		areOthersSelected: false,
		onToggleSelect: vi.fn(),
		menuActions: [],
		...overrides
	}
}

// ─── buildParticipantMenuButtons ─────────────────────────────────────────────

describe("buildParticipantMenuButtons", () => {
	describe("no ownerActions", () => {
		it("returns an empty array when ownerActions is undefined", () => {
			const result = buildParticipantMenuButtons({
				ownerActions: undefined,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result).toHaveLength(0)
			expect(result).toEqual([])
		})

		it("returns an empty array when ownerActions is undefined regardless of isSelected", () => {
			const result = buildParticipantMenuButtons({
				ownerActions: undefined,
				permission: "write",
				isSelected: true,
				t
			})

			expect(result).toHaveLength(0)
		})
	})

	describe("ownerActions without permission callbacks", () => {
		it("returns exactly one button with id='select' when no permission callbacks provided", () => {
			const ownerActions = makeOwnerActions()
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result).toHaveLength(1)
			expect(result[0]?.id).toBe("select")
		})

		it("select button title is t('select') when isSelected=false", () => {
			const ownerActions = makeOwnerActions({ isSelected: false })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result[0]?.title).toBe("select")
		})

		it("select button title is t('deselect') when isSelected=true", () => {
			const ownerActions = makeOwnerActions({ isSelected: true })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: true,
				t
			})

			expect(result[0]?.title).toBe("deselect")
		})

		it("select button checked is true when isSelected=true", () => {
			const ownerActions = makeOwnerActions({ isSelected: true })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: true,
				t
			})

			expect(result[0]?.checked).toBe(true)
		})

		it("select button checked is false when isSelected=false", () => {
			const ownerActions = makeOwnerActions({ isSelected: false })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result[0]?.checked).toBe(false)
		})

		it("only onSetPermission provided (no permissionLabels) → still one button, no permissions submenu", () => {
			const ownerActions = makeOwnerActions({
				onSetPermission: vi.fn(),
				permissionLabels: undefined
			})
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result).toHaveLength(1)
			expect(result[0]?.id).toBe("select")
		})

		it("only permissionLabels provided (no onSetPermission) → still one button, no permissions submenu", () => {
			const ownerActions = makeOwnerActions({
				onSetPermission: undefined,
				permissionLabels: { title: "Permission", read: "Read", write: "Write" }
			})
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result).toHaveLength(1)
			expect(result[0]?.id).toBe("select")
		})
	})

	describe("ownerActions WITH permission callbacks (permissions submenu branch)", () => {
		const permissionLabels = { title: "Permission", read: "Read", write: "Write" }
		const onSetPermission = vi.fn()

		it("returns two buttons: id='select' and id='permissions'", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "read",
				isSelected: false,
				t
			})

			expect(result).toHaveLength(2)
			expect(result[0]?.id).toBe("select")
			expect(result[1]?.id).toBe("permissions")
		})

		it("permissions button has subButtons array with id='read' and id='write'", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "read",
				isSelected: false,
				t
			})

			const permissionsBtn = result[1]

			expect(permissionsBtn?.subButtons).toBeDefined()
			expect(permissionsBtn?.subButtons).toHaveLength(2)
			expect(permissionsBtn?.subButtons?.[0]?.id).toBe("read")
			expect(permissionsBtn?.subButtons?.[1]?.id).toBe("write")
		})

		it("read subButton checked=true when permission='read'", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "read",
				isSelected: false,
				t
			})

			const subButtons = result[1]?.subButtons as MenuButton[]

			expect(subButtons[0]?.checked).toBe(true)
			expect(subButtons[1]?.checked).toBe(false)
		})

		it("write subButton checked=true when permission='write'", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "write",
				isSelected: false,
				t
			})

			const subButtons = result[1]?.subButtons as MenuButton[]

			expect(subButtons[0]?.checked).toBe(false)
			expect(subButtons[1]?.checked).toBe(true)
		})

		it("neither subButton checked when permission is undefined", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			const subButtons = result[1]?.subButtons as MenuButton[]

			expect(subButtons[0]?.checked).toBe(false)
			expect(subButtons[1]?.checked).toBe(false)
		})

		it("permissions button icon is 'edit' when permission='write'", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "write",
				isSelected: false,
				t
			})

			expect(result[1]?.icon).toBe("edit")
		})

		it("permissions button icon is 'eye' when permission='read'", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "read",
				isSelected: false,
				t
			})

			expect(result[1]?.icon).toBe("eye")
		})

		it("permissions button icon is 'eye' when permission is undefined", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result[1]?.icon).toBe("eye")
		})

		it("subButtons titles come from permissionLabels.read and permissionLabels.write", () => {
			const labels = { title: "Perm", read: "Reader", write: "Writer" }
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels: labels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "read",
				isSelected: false,
				t
			})

			const subButtons = result[1]?.subButtons as MenuButton[]

			expect(subButtons[0]?.title).toBe("Reader")
			expect(subButtons[1]?.title).toBe("Writer")
		})

		it("both subButtons have requiresOnline=true", () => {
			const ownerActions = makeOwnerActions({ onSetPermission, permissionLabels })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "read",
				isSelected: false,
				t
			})

			const subButtons = result[1]?.subButtons as MenuButton[]

			expect(subButtons[0]?.requiresOnline).toBe(true)
			expect(subButtons[1]?.requiresOnline).toBe(true)
		})
	})

	describe("ownerActions.menuActions merge (final spread)", () => {
		it("extra menuActions are appended after the select button when no permission callbacks", () => {
			const extraBtn: MenuButton = { id: "customAction", title: "Custom" }
			const ownerActions = makeOwnerActions({ menuActions: [extraBtn] })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result).toHaveLength(2)
			expect(result[0]?.id).toBe("select")
			expect(result[1]?.id).toBe("customAction")
		})

		it("extra menuActions are appended after both select and permissions buttons", () => {
			const permissionLabels = { title: "P", read: "R", write: "W" }
			const extraBtn: MenuButton = { id: "kick", title: "Kick" }
			const ownerActions = makeOwnerActions({
				onSetPermission: vi.fn(),
				permissionLabels,
				menuActions: [extraBtn]
			})
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "read",
				isSelected: false,
				t
			})

			expect(result).toHaveLength(3)
			expect(result[0]?.id).toBe("select")
			expect(result[1]?.id).toBe("permissions")
			expect(result[2]?.id).toBe("kick")
		})

		it("multiple extra menuActions are all appended in order", () => {
			const extras: MenuButton[] = [
				{ id: "a", title: "A" },
				{ id: "b", title: "B" }
			]
			const ownerActions = makeOwnerActions({ menuActions: extras })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result).toHaveLength(3)
			expect(result[1]?.id).toBe("a")
			expect(result[2]?.id).toBe("b")
		})

		it("empty menuActions array means no extra buttons appended", () => {
			const ownerActions = makeOwnerActions({ menuActions: [] })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			expect(result).toHaveLength(1)
		})
	})

	describe("select button onPress callback", () => {
		it("calling select button onPress invokes ownerActions.onToggleSelect", () => {
			const onToggleSelect = vi.fn()
			const ownerActions = makeOwnerActions({ onToggleSelect })
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: undefined,
				isSelected: false,
				t
			})

			result[0]?.onPress?.()

			expect(onToggleSelect).toHaveBeenCalledOnce()
		})
	})

	describe("permission subButton onPress callbacks", () => {
		it("pressing read subButton calls onSetPermission with 'read'", () => {
			const onSetPermission = vi.fn()
			const ownerActions = makeOwnerActions({
				onSetPermission,
				permissionLabels: { title: "P", read: "R", write: "W" }
			})
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "write",
				isSelected: false,
				t
			})

			const subButtons = result[1]?.subButtons as MenuButton[]
			subButtons[0]?.onPress?.()

			expect(onSetPermission).toHaveBeenCalledOnce()
			expect(onSetPermission).toHaveBeenCalledWith("read")
		})

		it("pressing write subButton calls onSetPermission with 'write'", () => {
			const onSetPermission = vi.fn()
			const ownerActions = makeOwnerActions({
				onSetPermission,
				permissionLabels: { title: "P", read: "R", write: "W" }
			})
			const result = buildParticipantMenuButtons({
				ownerActions,
				permission: "read",
				isSelected: false,
				t
			})

			const subButtons = result[1]?.subButtons as MenuButton[]
			subButtons[1]?.onPress?.()

			expect(onSetPermission).toHaveBeenCalledOnce()
			expect(onSetPermission).toHaveBeenCalledWith("write")
		})
	})
})
