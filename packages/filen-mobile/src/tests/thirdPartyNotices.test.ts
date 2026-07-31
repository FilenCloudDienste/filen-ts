import { describe, it, expect } from "vitest"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { LICENSE_TEXTS, THIRD_PARTY_NOTICES } from "@/features/settings/thirdPartyNotices.generated"

/**
 * The notices payload discharges a legal obligation, so the failure that matters is a SILENT one:
 * a dependency added or bumped without re-running scripts/generateThirdPartyNotices.ts leaves the
 * shipped attribution describing a tree the app no longer has, and nothing about the app misbehaves.
 *
 * The npm half is checked against the live lockfile, which CI can do without a cargo toolchain. The
 * Rust half is generated from the local crate cache, so it is checked for internal consistency only.
 */

const PACKAGE_ROOT = path.join(__dirname, "..", "..")

/**
 * Packages the lockfile ships AND that are actually installed here.
 *
 * The two differ by design: npm records every platform's optionalDependencies (the napi-rs, tailwind
 * and lightningcss native binaries for linux/windows/android) but installs only this machine's. Those
 * are build tooling and never reach a device, so a notice cannot and need not be produced for them —
 * which is why the guard is keyed on what is on disk rather than on the lockfile alone.
 */
function installedShippingPackages(): Set<string> {
	const lock = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package-lock.json"), "utf8")) as {
		packages?: Record<string, { dev?: boolean; devOptional?: boolean }>
	}

	const names = new Set<string>()

	for (const [key, meta] of Object.entries(lock.packages ?? {})) {
		if (!key.startsWith("node_modules/") || meta.dev === true || meta.devOptional === true) {
			continue
		}

		if (!existsSync(path.join(PACKAGE_ROOT, key, "package.json"))) {
			continue
		}

		names.add(key.replace(/.*node_modules\//, ""))
	}

	return names
}

describe("third-party notices payload", () => {
	it("covers exactly the installed npm packages that ship", () => {
		// The drift guard, and the reason this file exists: add, remove or bump a runtime dependency
		// without re-running the generator and this fails, naming what went missing or appeared. No
		// tolerance — every installed shipping package must be described, and nothing else may be.
		const expected = installedShippingPackages()
		const actual = new Set(THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "npm").map(notice => notice.name))

		expect([...expected].filter(name => !actual.has(name)).sort()).toEqual([])
		expect([...actual].filter(name => !expected.has(name)).sort()).toEqual([])
	})

	it("excludes build-only tooling", () => {
		// devDependencies never reach a device, so attributing them would overstate what ships.
		const names = new Set(THIRD_PARTY_NOTICES.map(notice => notice.name))

		for (const devOnly of ["vitest", "eslint", "prettier", "typescript"]) {
			expect(names.has(devOnly)).toBe(false)
		}
	})

	it("attributes the Rust crates the SDK is compiled from", () => {
		const crates = THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "rust")

		// The crates are linked into the binary and were unattributed before this payload existed.
		expect(crates.length).toBeGreaterThan(500)
		expect(crates.some(crate => crate.name === "tokio")).toBe(true)
	})

	it("gives every entry an identity and a license", () => {
		for (const notice of THIRD_PARTY_NOTICES) {
			expect(notice.name.length).toBeGreaterThan(0)
			expect(notice.license.length).toBeGreaterThan(0)
		}
	})

	it("resolves every license text index it points at", () => {
		// A dangling index renders a blank notice — the obligation unmet, with nothing visibly wrong.
		for (const notice of THIRD_PARTY_NOTICES) {
			if (notice.text < 0) {
				continue
			}

			expect(typeof LICENSE_TEXTS[notice.text]).toBe("string")
			expect((LICENSE_TEXTS[notice.text] ?? "").length).toBeGreaterThan(0)
		}
	})

	it("keeps the copyright out of the deduplicated terms", () => {
		// The whole reason terms can be shared across packages is that the holder was lifted out. If a
		// copyright line survived into a shared text, some package's notice now credits another's holder.
		const withCopyright = LICENSE_TEXTS.filter(text => /^\s*copyright\b/i.test(text))

		expect(withCopyright).toEqual([])
	})

	it("does not borrow a copyright for a package that shipped no license file", () => {
		// Reusing another package's text of the same license would attribute the wrong holder, so a
		// package without a file must point at nothing rather than at something plausible.
		const unlicensed = THIRD_PARTY_NOTICES.filter(notice => notice.text < 0)

		expect(unlicensed.every(notice => notice.copyright.length === 0)).toBe(true)
	})

	it("deduplicates the terms rather than storing one per package", () => {
		// Without this the payload is roughly 1.8 MB of near-identical MIT files.
		expect(LICENSE_TEXTS.length).toBeLessThan(THIRD_PARTY_NOTICES.length / 2)
	})
})
