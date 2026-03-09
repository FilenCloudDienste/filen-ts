---
name: tdd
description: >
    Apply test-driven development when writing or modifying code. Use when implementing
    features, fixing bugs, refactoring, or writing testable logic. Covers Jest/Vitest
    (unit/integration) and Maestro (mobile E2E). Tests are required for non-trivial code.
    Trigger when user mentions tests, coverage, TDD, spec, E2E, or flows.
---

# Test-Driven Development

Tests are not optional. Every non-trivial piece of logic ships with tests. Red, green, refactor.

## Step 0 — Inspect the project first

```
Read(file_path: "/absolute/path/to/package.json")

Glob(pattern: "jest.config.*")
Glob(pattern: "vitest.config.*")
Glob(pattern: "**/*.test.ts")
Glob(pattern: ".maestro/**/*.yaml")
```

Match existing conventions. Never introduce a second testing library.

---

## The TDD Cycle

1. **UNDERSTAND** — inputs, outputs, edge cases
2. **TEST** — write tests that specify behavior
3. **IMPLEMENT** — minimum code to make tests pass
4. **VERIFY** — run tests, confirm green
5. **REFACTOR** — clean up with tests as safety net

**Order is flexible:** new feature: tests first or alongside. Bug fix: failing test first. Exploratory: implement freely, tests before it's "done". Refactor: tests must exist before touching code.

---

## Jest / Vitest

### Test file location — match the project

```
Glob(pattern: "src/**/*.test.*")
# Co-located: src/utils/format.test.ts (common in RN/Expo)
# Separate: src/__tests__/utils/format.test.ts
```

### Structure

```typescript
describe("formatBytes", () => {
	it("formats bytes to human-readable string", () => {
		expect(formatBytes(1024)).toBe("1 KB")
	})

	it("handles zero", () => {
		expect(formatBytes(0)).toBe("0 B")
	})

	it("throws on negative input", () => {
		expect(() => formatBytes(-1)).toThrow("Input must be non-negative")
	})
})
```

### What to test

**Test:** return values, edge cases (empty, zero, null, boundary), error conditions, side effects, async behavior.

**Don't test:** implementation details, third-party internals, trivial getters, type definitions, private methods directly.

### Assertions — be specific

```typescript
// ❌ Too vague
expect(result).toBeTruthy()

// ✅ Specific
expect(result).toBe("expected string")
expect(result).toEqual({ id: 1, name: "Jan" })
expect(mockFn).toHaveBeenCalledWith("expected-arg")
expect(mockFn).toHaveBeenCalledTimes(1)
expect(() => parse("")).toThrow("Input cannot be empty")
```

### Mocking — mock at the boundary

```typescript
// ✅ Mock external dependencies
vi.mock("../api/users", () => ({
	fetchUser: vi.fn().mockResolvedValue({ id: "1", name: "Jan" })
}))

afterEach(() => {
	vi.restoreAllMocks()
})

// ❌ Don't mock the unit under test
// ❌ Don't mock internal pure functions
```

### Async tests

```typescript
it("fetches user data", async () => {
	const user = await getUser("123")
	expect(user.name).toBe("Jan")
})

it("throws on not found", async () => {
	await expect(getUser("nonexistent")).rejects.toThrow("User not found")
})
```

### React Native component tests

```typescript
import { render, fireEvent } from "@testing-library/react-native"

it("calls onPress when button is tapped", () => {
	const onPress = jest.fn()
	const { getByText } = render(<SubmitButton onPress={onPress} label="Submit" />)
	fireEvent.press(getByText("Submit"))
	expect(onPress).toHaveBeenCalledTimes(1)
})
```

Test behavior: correct content for props, correct callbacks on interaction, show/hide based on state, loading/error states. Never test internal state or refs.

---

## Maestro — Mobile E2E

### File structure

```
.maestro/
  flows/
    login.yaml
    upload_file.yaml
```

### Writing flows

```yaml
appId: com.example.app
---
- launchApp
- tapOn: "Drive"
- tapOn:
    id: "upload-button"
- assertVisible:
    text: "document.pdf"
    timeout: 10000
- assertVisible: "Upload complete"
```

### Locators

```yaml
# ✅ Best — testID (matches testID="upload-button" in RN)
- tapOn:
    id: "upload-button"

# ✅ Good — visible text
- tapOn: "Upload"
```

Use `assertVisible` with timeout instead of fixed sleeps.

### When to use Maestro

**Yes:** critical user journeys, native OS interactions (file picker, camera, permissions), deep links.
**No:** unit logic, component rendering, anything verifiable without a device.

```bash
maestro test .maestro/flows/upload_file.yaml
maestro test .maestro/flows/
maestro studio
```

---

## Bug Fix Protocol

1. Write a test that reproduces the bug (must fail)
2. Confirm it fails
3. Fix the bug
4. Confirm it passes
5. Run full suite — nothing else broke

---

## Coverage

Coverage is a signal, not a goal. 100% with weak assertions is worthless.

Aim for: all happy paths, all error paths, edge cases and boundaries.

```bash
npx vitest --coverage
npx jest --coverage
```

---

## Test Data

Prefer real API data over mocks when the server is reachable. When mocking, mirror the real response shape precisely — check docs or existing code first. When the real API isn't available, ask the user before inventing data.
