import { vi, describe, it, expect } from "vitest"

// Mocks must be before any import that triggers the mocked modules.

vi.mock("react-native", async () => await import("@/tests/mocks/reactNative"))

vi.mock("uniffi-bindgen-react-native", async () => await import("@/tests/mocks/uniffiBindgenReactNative"))

vi.mock("@filen/utils", async () => await import("@/tests/mocks/filenUtils"))

vi.mock("react-native-ios-context-menu", () => ({
	ContextMenuView: () => null,
	ContextMenuButton: () => null
}))

vi.mock("@react-native-menu/menu", () => ({
	MenuView: () => null
}))

vi.mock("uniwind", () => ({
	withUniwind: (c: unknown) => c,
	useResolveClassNames: () => ({}),
	useUniwind: () => ({ theme: "dark" })
}))

vi.mock("@/hooks/useIsOnline", () => ({
	default: () => true
}))

vi.mock("@expo/ui/swift-ui", () => ({
	Image: () => null
}))

// iconToSwiftUiIcon is pure — let the real impl run so icon config assertions work.
// We only need to stub the native Image component above.

import {
	applyOfflineGate,
	findButtonById,
	checkIfButtonIdsAreUnique,
	iosMenuAttributesFromButton,
	toIosMenuSubMenuConfig,
	toIosMenuElementConfig,
	toReactNativeMenuActions,
	type MenuButton
} from "@/components/ui/menu"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function btn(id: string, overrides: Partial<MenuButton> = {}): MenuButton {
	return { id, title: id, ...overrides }
}

// ---------------------------------------------------------------------------
// #75 — applyOfflineGate
// ---------------------------------------------------------------------------

describe("applyOfflineGate", () => {
	it("(a) requiresOnline=true + offline → disabled===true", () => {
		const result = applyOfflineGate(btn("x", { requiresOnline: true }), false)

		expect(result.disabled).toBe(true)
	})

	it("(b) requiresOnline=true + online → disabled===false", () => {
		const result = applyOfflineGate(btn("x", { requiresOnline: true }), true)

		expect(result.disabled).toBe(false)
	})

	it("(c) button with subButtons — recursion preserves subButtons key", () => {
		const child = btn("child", { requiresOnline: true })
		const parent = btn("parent", { subButtons: [child] })
		const result = applyOfflineGate(parent, false)

		expect("subButtons" in result).toBe(true)
		expect(result.subButtons).toHaveLength(1)
		expect(result.subButtons?.[0]?.disabled).toBe(true)
	})

	it("(d) leaf button (no subButtons) — result must NOT contain subButtons key", () => {
		const result = applyOfflineGate(btn("leaf"), true)

		expect("subButtons" in result).toBe(false)
	})

	it("(e) already-disabled leaf stays disabled regardless of online state", () => {
		const resultOffline = applyOfflineGate(btn("x", { disabled: true, requiresOnline: true }), false)
		const resultOnline = applyOfflineGate(btn("x", { disabled: true, requiresOnline: false }), true)

		expect(resultOffline.disabled).toBe(true)
		expect(resultOnline.disabled).toBe(true)
	})

	it("(f) requiresOnline=false + offline → disabled stays falsy", () => {
		const result = applyOfflineGate(btn("x", { requiresOnline: false }), false)

		expect(result.disabled).toBeFalsy()
	})

	it("normal leaf button (no subButtons key at all) — returned object has no subButtons key", () => {
		// The iOS rendering path uses 'subButtons' in button as leaf-vs-submenu discriminator.
		// A button constructed WITHOUT the subButtons key must not gain it through the spread.
		const leaf: MenuButton = { id: "leaf", title: "Leaf" }

		// Verify the input truly has no subButtons key
		expect("subButtons" in leaf).toBe(false)

		const result = applyOfflineGate(leaf, false)

		// The returned object should also have no subButtons key
		expect("subButtons" in result).toBe(false)
	})
})

// ---------------------------------------------------------------------------
// #77 — findButtonById
// ---------------------------------------------------------------------------

describe("findButtonById", () => {
	it("(a) direct top-level hit returns the button", () => {
		const a = btn("a")
		const result = findButtonById([a, btn("b")], "a")

		expect(result).toBe(a)
	})

	it("(b) nested subButton hit returns the sub-button", () => {
		const sub = btn("sub")
		const parent = btn("parent", { subButtons: [sub] })
		const result = findButtonById([parent], "sub")

		expect(result).toBe(sub)
	})

	it("(c) not found → null", () => {
		expect(findButtonById([btn("a"), btn("b")], "z")).toBeNull()
	})

	it("(d) empty array → null", () => {
		expect(findButtonById([], "x")).toBeNull()
	})

	it("(e) multi-level nesting — finds deeply nested button", () => {
		const deep = btn("deep")
		const mid = btn("mid", { subButtons: [deep] })
		const root = btn("root", { subButtons: [mid] })
		expect(findButtonById([root], "deep")).toBe(deep)
	})

	it("returns null for falsy/undefined buttons (guard at line 65)", () => {
		// The function has 'if (!buttons) return null' guard
		expect(findButtonById(null as unknown as MenuButton[], "x")).toBeNull()
	})
})

// ---------------------------------------------------------------------------
// #76 — checkIfButtonIdsAreUnique
// ---------------------------------------------------------------------------

describe("checkIfButtonIdsAreUnique", () => {
	it("(a) all top-level IDs unique → true", () => {
		expect(checkIfButtonIdsAreUnique([btn("a"), btn("b"), btn("c")])).toBe(true)
	})

	it("(b) top-level duplicate → false", () => {
		expect(checkIfButtonIdsAreUnique([btn("a"), btn("a")])).toBe(false)
	})

	it("(c) ID duplicated between top-level and a subButton → false", () => {
		const parent = btn("a", { subButtons: [btn("b")] })

		// 'b' appears both as a subButton of 'a' and as a top-level button
		expect(checkIfButtonIdsAreUnique([parent, btn("b")])).toBe(false)
	})

	it("(d) ID duplicated within two different subButton arrays → false", () => {
		const p1 = btn("p1", { subButtons: [btn("dup")] })
		const p2 = btn("p2", { subButtons: [btn("dup")] })

		expect(checkIfButtonIdsAreUnique([p1, p2])).toBe(false)
	})

	it("(e) empty array → true", () => {
		expect(checkIfButtonIdsAreUnique([])).toBe(true)
	})

	it("(f) single button no subButtons → true", () => {
		expect(checkIfButtonIdsAreUnique([btn("solo")])).toBe(true)
	})

	it("all-unique nested hierarchy → true", () => {
		const parent = btn("parent", { subButtons: [btn("child1"), btn("child2")] })

		expect(checkIfButtonIdsAreUnique([parent, btn("sibling")])).toBe(true)
	})
})

// ---------------------------------------------------------------------------
// #78 — iosMenuAttributesFromButton
// ---------------------------------------------------------------------------

describe("iosMenuAttributesFromButton", () => {
	it("(a) all flags false/absent → empty array", () => {
		expect(iosMenuAttributesFromButton(btn("x"))).toEqual([])
	})

	it("(b) only destructive → ['destructive']", () => {
		expect(iosMenuAttributesFromButton(btn("x", { destructive: true }))).toEqual(["destructive"])
	})

	it("only disabled → ['disabled']", () => {
		expect(iosMenuAttributesFromButton(btn("x", { disabled: true }))).toEqual(["disabled"])
	})

	it("only hidden → ['hidden']", () => {
		expect(iosMenuAttributesFromButton(btn("x", { hidden: true }))).toEqual(["hidden"])
	})

	it("(d) keepMenuOpenOnPress=true → 'keepsMenuPresented' added", () => {
		expect(iosMenuAttributesFromButton(btn("x", { keepMenuOpenOnPress: true }))).toEqual(["keepsMenuPresented"])
	})

	it("(c) multiple flags → array contains all relevant strings", () => {
		const attrs = iosMenuAttributesFromButton(btn("x", { destructive: true, disabled: true, hidden: true, keepMenuOpenOnPress: true }))

		expect(attrs).toContain("destructive")
		expect(attrs).toContain("disabled")
		expect(attrs).toContain("hidden")
		expect(attrs).toContain("keepsMenuPresented")
		expect(attrs).toHaveLength(4)
	})

	it("destructive + disabled → two-element array in order", () => {
		const attrs = iosMenuAttributesFromButton(btn("x", { destructive: true, disabled: true }))

		expect(attrs).toEqual(["destructive", "disabled"])
	})
})

// ---------------------------------------------------------------------------
// #79 — toIosMenuElementConfig / toIosMenuSubMenuConfig
// ---------------------------------------------------------------------------

describe("toIosMenuElementConfig", () => {
	it("(a) loading=true → {type:'deferred', deferredID} returned", () => {
		const result = toIosMenuElementConfig(btn("x", { loading: true }))

		expect(result).toMatchObject({ type: "deferred" })
		expect("deferredID" in result).toBe(true)
	})

	it("(b) normal leaf button returns actionKey/actionTitle", () => {
		const result = toIosMenuElementConfig(btn("action-id", { title: "My Action" }))

		expect(result).toMatchObject({ actionKey: "action-id", actionTitle: "My Action" })
	})

	it("(c) checked=true → menuState='on'", () => {
		const result = toIosMenuElementConfig(btn("x", { checked: true }))

		expect(result).toMatchObject({ menuState: "on" })
	})

	it("checked=false/absent → menuState undefined", () => {
		const result = toIosMenuElementConfig(btn("x"))

		expect((result as { menuState?: string }).menuState).toBeUndefined()
	})

	it("button with icon → icon config set", () => {
		const result = toIosMenuElementConfig(btn("x", { icon: "heart" }))

		// iconToSwiftUiIcon('heart') returns 'heart'
		expect(result).toMatchObject({
			icon: {
				type: "IMAGE_SYSTEM",
				imageValue: { systemName: "heart" }
			}
		})
	})
})

describe("toIosMenuSubMenuConfig", () => {
	it("(a) loading=true → deferred shape", () => {
		const result = toIosMenuSubMenuConfig(btn("x", { loading: true }))

		expect(result).toMatchObject({ type: "deferred" })
		expect("deferredID" in result).toBe(true)
	})

	it("(d) subButtonsInline=true → menuOptions=['displayInline']", () => {
		const result = toIosMenuSubMenuConfig(btn("x", { subButtonsInline: true, subButtons: [] }))

		expect(result).toMatchObject({ menuOptions: ["displayInline"] })
	})

	it("subButtonsInline absent → menuOptions undefined", () => {
		const result = toIosMenuSubMenuConfig(btn("x"))

		expect((result as { menuOptions?: unknown }).menuOptions).toBeUndefined()
	})

	it("button with subButtons → menuItems array present", () => {
		const parent = btn("parent", { subButtons: [btn("child")] })
		const result = toIosMenuSubMenuConfig(parent)

		expect((result as { menuItems?: unknown[] }).menuItems).toHaveLength(1)
	})

	it("subButtons discriminator — child WITH subButtons routed through sub-menu config (has menuTitle)", () => {
		// When 'subButtons' in button, toIosMenuSubMenuConfig is called recursively
		const grandchild = btn("gc", { subButtons: [] })
		const child = btn("child", { subButtons: [grandchild] })
		const parent = btn("parent", { subButtons: [child] })
		const result = toIosMenuSubMenuConfig(parent) as { menuItems?: { menuTitle?: string; actionKey?: string }[] }

		// child has subButtons in it, so it gets a menuTitle (not actionKey)
		expect(result.menuItems?.[0]).toHaveProperty("menuTitle")
		expect(result.menuItems?.[0]).not.toHaveProperty("actionKey")
	})
})

// ---------------------------------------------------------------------------
// #80 — toReactNativeMenuActions
// ---------------------------------------------------------------------------

const COLORS = {
	normal: "#ffffff",
	destructive: "#ff0000",
	disabled: "#888888"
}

describe("toReactNativeMenuActions", () => {
	it("(a) button with subButtons → subactions set", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("parent", { subButtons: [btn("child")] })],
			colors: COLORS
		})

		expect(actions[0]?.subactions).toBeDefined()
		expect(actions[0]?.subactions).toHaveLength(1)
	})

	it("(b) button without subButtons → subactions is undefined", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("leaf")],
			colors: COLORS
		})

		expect(actions[0]?.subactions).toBeUndefined()
	})

	it("(c) button.checked=true → state='on'", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("x", { checked: true })],
			colors: COLORS
		})

		expect(actions[0]?.state).toBe("on")
	})

	it("button.checked absent → state undefined", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("x")],
			colors: COLORS
		})

		expect(actions[0]?.state).toBeUndefined()
	})

	it("(d) button.destructive=true + iosIcon present → imageColor=colors.destructive", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("x", { destructive: true, icon: "trash" })],
			colors: COLORS
		})

		expect(actions[0]?.imageColor).toBe(COLORS.destructive)
	})

	it("(e) button.disabled=true + iosIcon present → imageColor=colors.disabled", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("x", { disabled: true, icon: "trash" })],
			colors: COLORS
		})

		expect(actions[0]?.imageColor).toBe(COLORS.disabled)
	})

	it("(f) normal button + iosIcon → imageColor=colors.normal", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("x", { icon: "heart" })],
			colors: COLORS
		})

		expect(actions[0]?.imageColor).toBe(COLORS.normal)
	})

	it("button without icon and without iconColor → imageColor undefined (no iosIcon spread)", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("x", { destructive: true })],
			colors: COLORS
		})

		// No iosIcon → the spread is skipped, so imageColor key is absent/undefined
		expect(actions[0]?.imageColor).toBeUndefined()
	})

	it("button with iconColor but no icon → imageColor equals iconColor", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("x", { iconColor: "#cafeba" })],
			colors: COLORS
		})

		expect(actions[0]?.imageColor).toBe("#cafeba")
	})

	it("returns correctly shaped array for multiple buttons", () => {
		const actions = toReactNativeMenuActions({
			buttons: [btn("a", { title: "A" }), btn("b", { title: "B" })],
			colors: COLORS
		})

		expect(actions).toHaveLength(2)
		expect(actions[0]?.id).toBe("a")
		expect(actions[1]?.id).toBe("b")
	})
})
