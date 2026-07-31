import { describe, it, expect } from "vitest"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { LICENSE_TEXTS, THIRD_PARTY_NOTICES } from "@/features/settings/thirdPartyNotices.generated"

/**
 * The notices payload discharges a legal obligation, so the failure that matters is a SILENT one:
 * a dependency added or bumped without re-running scripts/generateThirdPartyNotices.ts leaves the
 * shipped attribution describing a tree the app no longer has, and nothing about the app misbehaves.
 *
 * Generation reads four local caches — node_modules, the cargo registry, ios/Pods and the Gradle cache
 * — and no one machine reliably holds all four. So each ecosystem is checked against its own source of
 * truth when that source is present, and when it is absent the payload must still describe that
 * ecosystem: a checkout missing a prebuild has to fail loudly rather than quietly shipping less.
 */

/** Directories CocoaPods generates inside ios/Pods that are not pods. */
const POD_INFRASTRUCTURE = new Set(["Headers", "Local Podspecs", "Target Support Files", "Pods.xcodeproj", "hermes-engine-artifacts"])

const PACKAGE_ROOT = path.join(__dirname, "..", "..")

/**
 * The packages the lockfile says reach a device.
 *
 * Read from the lockfile alone, never from what is installed here: the lockfile is committed, so this
 * set is identical on every machine, and the payload has to satisfy CI as much as the laptop it was
 * generated on.
 *
 * `optional` is what makes that hold. npm decides per machine whether to install one — a macOS run
 * gets the darwin native binaries, CI's Linux run the linux ones — so counting them made the payload
 * describe wherever it happened to be generated. Every optional entry here is build tooling that
 * cannot execute on a device anyway: the lightningcss/oxide/napi-rs binaries and their wasm fallbacks,
 * pdf.js's Node canvas backend (the app runs pdf.js in a WebView), and type-only packages.
 */
function installedShippingPackages(): Set<string> {
	const lock = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package-lock.json"), "utf8")) as {
		packages?: Record<string, { dev?: boolean; devOptional?: boolean; optional?: boolean }>
	}

	const names = new Set<string>()

	for (const [key, meta] of Object.entries(lock.packages ?? {})) {
		if (!key.startsWith("node_modules/") || meta.dev === true || meta.devOptional === true || meta.optional === true) {
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

	it("describes every ecosystem that ships", () => {
		// A machine missing one of the four caches would otherwise emit a payload that looks complete.
		const covered = new Set(THIRD_PARTY_NOTICES.map(notice => notice.ecosystem))

		expect([...covered].sort()).toEqual(["gradle", "npm", "pod", "rust"])
	})

	it("covers every pod CocoaPods vendors into the iOS build", () => {
		// A pod only lands in ios/Pods when it comes from the CDN or a podspec — one backed by a path into
		// node_modules is referenced where it lies and described as an npm package instead. So these
		// directories ARE the residue, including the C++ libraries React Native downloads (boost, glog,
		// folly, double-conversion), whose licenses appear nowhere in the npm tree.
		const podsRoot = path.join(PACKAGE_ROOT, "ios", "Pods")
		const described = new Set(THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "pod").map(notice => notice.name))

		if (!existsSync(podsRoot)) {
			expect(described.size).toBeGreaterThan(0)

			return
		}

		const installed = readdirSync(podsRoot, { withFileTypes: true })
			.filter(entry => entry.isDirectory() && !POD_INFRASTRUCTURE.has(entry.name))
			.map(entry => entry.name)

		expect(installed.filter(name => !described.has(name)).sort()).toEqual([])
	})

	it("covers every Maven module Gradle links into the Android build", () => {
		const manifestPath = path.join(
			PACKAGE_ROOT,
			"android",
			"app",
			"build",
			"outputs",
			"sdk-dependencies",
			"release",
			"sdkDependencies.txt"
		)
		const described = new Set(THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "gradle").map(notice => notice.name))

		if (!existsSync(manifestPath)) {
			expect(described.size).toBeGreaterThan(0)

			return
		}

		const installed = [
			...readFileSync(manifestPath, "utf8").matchAll(/maven_library \{\s*groupId: "([^"]+)"\s*artifactId: "([^"]+)"/g)
		].map(match => `${match[1]}:${match[2]}`)

		expect(installed.filter(name => !described.has(name)).sort()).toEqual([])
	})

	it("gives Apache-2.0 packages the canonical terms when they shipped no file", () => {
		// 5 of 248 Maven artifacts embed their license, so without this the Android half would ship almost
		// no terms at all. Safe only because an Apache-2.0 file carries no holder — its appendix is a
		// placeholder — which is why the same does not happen for MIT or BSD.
		const apache = THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "gradle" && /apache/i.test(notice.license))

		expect(apache.length).toBeGreaterThan(100)
		expect(apache.filter(notice => notice.texts.length === 0)).toEqual([])
	})

	it("lends the Apache document itself, not a file that merely contains one", () => {
		// The canonical text was first chosen as the LONGEST pooled text containing Apache-2.0's wording.
		// MMKV's LICENSE.TXT bundles a full copy inside a longer file, so it won, and every Apache-
		// declaring Maven module rendered Tencent's terms under an androidx name.
		const shared = new Set(THIRD_PARTY_NOTICES.filter(notice => notice.ecosystem === "gradle").flatMap(notice => notice.texts))

		expect(shared.size).toBe(1)

		for (const index of shared) {
			expect((LICENSE_TEXTS[index] ?? "").trimStart().startsWith("Apache License")).toBe(true)
			expect(LICENSE_TEXTS[index]).toContain("APPENDIX: How to apply the Apache License to your work")
		}
	})

	it("never lends a holder-bearing license to a package that shipped none", () => {
		// The mirror of the rule above: an MIT or BSD file IS the holder, so a package without one must
		// point at nothing rather than at another author's text.
		const borrowed = THIRD_PARTY_NOTICES.filter(
			notice => notice.ecosystem === "gradle" && notice.texts.length > 0 && !/apache/i.test(notice.license)
		)

		expect(borrowed).toEqual([])
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
			for (const index of notice.texts) {
				expect(typeof LICENSE_TEXTS[index]).toBe("string")
				expect((LICENSE_TEXTS[index] ?? "").length).toBeGreaterThan(0)
			}
		}
	})

	it("lifts the copyright out of the terms so it can be shown per package", () => {
		// The lift is what lets terms be shared, and it used to stop at the first non-blank line — so
		// any license file opening with a title ("MIT License", "(The MIT License)") kept its holder
		// buried in the shared body. It affected 411 of 453 texts and left 1456 entries rendering an
		// empty copyright block, while collapsing far fewer texts than it should have.
		//
		// The previous version of this test could not see any of that: its regex had no `m` flag, so it
		// only ever inspected character 0 of each text and matched 0 of the 411.
		const withText = THIRD_PARTY_NOTICES.filter(notice => notice.texts.length > 0)
		const withCopyright = withText.filter(notice => notice.copyright.length > 0)

		// Pre-fix this ratio was 11.6%.
		expect(withCopyright.length / withText.length).toBeGreaterThan(0.5)

		// And a couple of concrete holders, so the ratio cannot be satisfied by lifting the wrong lines.
		const expo = THIRD_PARTY_NOTICES.find(notice => notice.name === "expo")

		expect(expo?.copyright.some(line => line.includes("650 Industries"))).toBe(true)
	})

	it("never lifts a license template's placeholder as a copyright holder", () => {
		// Apache-2.0's appendix and the BSD template carry `Copyright [yyyy] [name of copyright owner]`.
		// Lifting one would print a fake holder above the terms — worse than printing none.
		const placeholder = /\[yyyy\]|\[name of copyright owner\]|<year>|<name of author>/i

		for (const notice of THIRD_PARTY_NOTICES) {
			expect(notice.copyright.some(line => placeholder.test(line))).toBe(false)
		}
	})

	it("does not borrow a copyright for a package that shipped no license file", () => {
		// Reusing another package's text of the same license would attribute the wrong holder, so a
		// package without a file must point at nothing rather than at something plausible.
		const unlicensed = THIRD_PARTY_NOTICES.filter(notice => notice.texts.length === 0)

		expect(unlicensed.every(notice => notice.copyright.length === 0)).toBe(true)
	})

	it("deduplicates the terms rather than storing one per package", () => {
		// Without this the payload is roughly 1.8 MB of near-identical MIT files.
		//
		// Sharing is safe because the dedup key is the terms VERBATIM: a text can only be shared by
		// packages whose license files match byte for byte, so a holder still sitting inside a shared
		// text is the holder of every package sharing it. In the payload those groups are same-author
		// families — futures-*, windows-*, zerocopy and its derive macro. Not asserted here because
		// every formulation I tried was either vacuous or needed a license-detector too crude to trust.
		expect(LICENSE_TEXTS.length).toBeLessThan(THIRD_PARTY_NOTICES.length / 2)
	})
})
