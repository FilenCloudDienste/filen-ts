import { describe, it, expect, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import JSZip from "jszip"
// plugins/ and scripts/ sit outside src/, so no "@/" alias — relative imports are fine in tests.
import {
	aarUrl,
	assertVerifierVersions,
	buildNetworkSecurityConfig,
	cargoLockVersion,
	extractAarNetworkSecurityConfig,
	isHostCovered,
	loadRustlsPlatformVerifierAar,
	parseCleartextDomains,
	RUSTLS_PLATFORM_VERIFIER
} from "../../plugins/rustlsPlatformVerifier"
import {
	addRustlsDependency,
	addRustlsMavenRepository,
	addRustlsProguardRule,
	PROGUARD_RULE
} from "../../plugins/withAndroidRustlsPlatformVerifier"
import { crlDistributionPoints } from "../../scripts/checkCrlHosts"

// The shape of the AAR's res/xml/network_security_config.xml (rustls-platform-verifier 0.2.0).
const AAR_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <!-- generated from ccadb -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">c.pki.goog</domain>
    <domain includeSubdomains="true">yr1.c.lencr.org</domain>
    <domain includeSubdomains="true">lencr.org</domain>
    <domain includeSubdomains="false">crl.Example.com</domain>
  </domain-config>
</network-security-config>`

// Expo prebuild template's android/build.gradle.
const PROJECT_BUILD_GRADLE = `buildscript {
  repositories {
    google()
    mavenCentral()
  }
}

allprojects {
  repositories {
    google()
    mavenCentral()
    maven { url 'https://www.jitpack.io' }
  }
}

apply plugin: "expo-root-project"
`

function cargoLock(version: string | null): string {
	return `version = 4

[[package]]
name = "rustls-platform-verifier"
version = "0.7.1"
source = "registry+https://github.com/rust-lang/crates.io-index"
${
	version === null
		? ""
		: `
[[package]]
name = "rustls-platform-verifier-android"
version = "${version}"
source = "registry+https://github.com/rust-lang/crates.io-index"
`
}
[[package]]
name = "zstd"
version = "0.13.3"
`
}

describe("network security config generation", () => {
	it("reads the cleartext domains of the AAR's config", () => {
		expect(parseCleartextDomains(AAR_XML)).toEqual([
			{ host: "c.pki.goog", includeSubdomains: true },
			{ host: "yr1.c.lencr.org", includeSubdomains: true },
			{ host: "lencr.org", includeSubdomains: true },
			{ host: "crl.example.com", includeSubdomains: false }
		])
	})

	it("ignores domain-configs that do not permit cleartext", () => {
		expect(
			parseCleartextDomains(
				`<network-security-config><domain-config cleartextTrafficPermitted="false"><domain includeSubdomains="true">a.com</domain></domain-config></network-security-config>`
			)
		).toEqual([])
	})

	it("keeps the app's hosts, adds lencr.org and the AAR's CRL hosts, each domain once", () => {
		const xml = buildNetworkSecurityConfig({ appCleartextHosts: ["127.0.0.1", "10.0.2.2"], aarNetworkSecurityConfig: AAR_XML })
		const hosts = [...xml.matchAll(/<domain includeSubdomains="(true|false)">([^<]+)<\/domain>/g)].map(
			match => `${match[2]}:${match[1]}`
		)

		expect(hosts).toEqual([
			"127.0.0.1:true",
			"10.0.2.2:true",
			"lencr.org:true",
			"c.pki.goog:true",
			"yr1.c.lencr.org:true",
			"crl.example.com:false"
		])
		expect(xml).toContain(`${RUSTLS_PLATFORM_VERIFIER.group}:${RUSTLS_PLATFORM_VERIFIER.artifact}:${RUSTLS_PLATFORM_VERIFIER.version}`)
		// Every domain-config of the result permits cleartext and parses back.
		expect(parseCleartextDomains(xml)).toHaveLength(hosts.length)
	})

	it("fails when the AAR's config lists no CRL domains (its shape changed)", () => {
		expect(() =>
			buildNetworkSecurityConfig({ appCleartextHosts: ["127.0.0.1"], aarNetworkSecurityConfig: "<network-security-config />" })
		).toThrow(/No cleartext CRL domains/)
	})

	it("covers a host by exact match or as a subdomain of an includeSubdomains entry", () => {
		const domains = parseCleartextDomains(AAR_XML)

		expect(isHostCovered("yr1.c.lencr.org", domains)).toBe(true)
		expect(isHostCovered("x1.c.lencr.org", domains)).toBe(true)
		expect(isHostCovered("crl.example.com", domains)).toBe(true)
		expect(isHostCovered("sub.crl.example.com", domains)).toBe(false)
		expect(isHostCovered("notlencr.org", domains)).toBe(false)
	})

	it("extracts the config from the AAR archive", async () => {
		const zip = new JSZip()

		zip.file("res/xml/network_security_config.xml", AAR_XML)

		expect(await extractAarNetworkSecurityConfig(await zip.generateAsync({ type: "uint8array" }))).toBe(AAR_XML)
		await expect(extractAarNetworkSecurityConfig(await new JSZip().generateAsync({ type: "uint8array" }))).rejects.toThrow(
			/no res\/xml\/network_security_config.xml/
		)
	})
})

describe("AAR download", () => {
	let tmpRoot: string | null = null

	afterEach(() => {
		if (tmpRoot) {
			fs.rmSync(tmpRoot, { recursive: true, force: true })
			tmpRoot = null
		}
	})

	it("points at upstream's Maven layout", () => {
		expect(aarUrl()).toBe(
			"https://github.com/rustls/rustls-platform-verifier/raw/maven-archive/android-release-support/maven/org/rustls/rustls-platform-verifier/0.2.0/rustls-platform-verifier-0.2.0.aar"
		)
	})

	it("refuses a download whose sha256 differs from the pin, and caches nothing", async () => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rpv-"))

		const fakeFetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch

		await expect(loadRustlsPlatformVerifierAar(tmpRoot, fakeFetch)).rejects.toThrow(/sha256/)
		expect(fs.existsSync(path.join(tmpRoot, "node_modules", ".cache"))).toBe(false)
	})

	it("refetches over a corrupted cache entry and reports an HTTP failure", async () => {
		tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rpv-"))

		const cacheDir = path.join(tmpRoot, "node_modules", ".cache", RUSTLS_PLATFORM_VERIFIER.artifact)

		fs.mkdirSync(cacheDir, { recursive: true })
		fs.writeFileSync(path.join(cacheDir, `${RUSTLS_PLATFORM_VERIFIER.artifact}-${RUSTLS_PLATFORM_VERIFIER.version}.aar`), "corrupt")

		let fetched = 0
		const fakeFetch = (async () => {
			fetched++

			return new Response(null, { status: 404 })
		}) as typeof fetch

		await expect(loadRustlsPlatformVerifierAar(tmpRoot, fakeFetch)).rejects.toThrow(/HTTP 404/)
		expect(fetched).toBe(1)
	})
})

describe("AAR version check", () => {
	it("reads the pinned crate version from a Cargo.lock", () => {
		expect(cargoLockVersion(cargoLock("0.2.0"), "rustls-platform-verifier-android")).toBe("0.2.0")
		expect(cargoLockVersion(cargoLock("0.2.0"), "rustls-platform-verifier")).toBe("0.7.1")
		expect(cargoLockVersion(cargoLock(null), "rustls-platform-verifier-android")).toBeNull()
	})

	it("passes when every Rust build pins the AAR's version", () => {
		expect(() =>
			assertVerifierVersions([
				{ label: "filen-rs submodule", path: "a/Cargo.lock", lock: cargoLock("0.2.0") },
				{ label: "@filen/sdk-rs", path: "b/Cargo.lock", lock: cargoLock("0.2.0") }
			])
		).not.toThrow()
	})

	it("fails on a mismatch, a lock without the crate, and a missing lock, naming each", () => {
		let message = ""

		try {
			assertVerifierVersions([
				{ label: "filen-rs submodule", path: "a/Cargo.lock", lock: cargoLock("0.1.1") },
				{ label: "@filen/sdk-rs", path: "b/Cargo.lock", lock: cargoLock(null) },
				{ label: "other", path: "c/Cargo.lock", lock: null }
			])
		} catch (e) {
			message = (e as Error).message
		}

		expect(message).toContain("AAR is 0.2.0")
		expect(message).toContain("filen-rs submodule: a/Cargo.lock pins rustls-platform-verifier-android 0.1.1")
		expect(message).toContain("@filen/sdk-rs: b/Cargo.lock does not pin rustls-platform-verifier-android")
		expect(message).toContain("other: c/Cargo.lock not found")
	})
})

describe("Gradle and R8 edits", () => {
	it("adds upstream's Maven repository to allprojects, scoped to org.rustls", () => {
		const out = addRustlsMavenRepository(PROJECT_BUILD_GRADLE)
		const allprojects = out.slice(out.indexOf("allprojects {"), out.indexOf("apply plugin"))

		expect(allprojects).toContain(
			[
				"  repositories {",
				"    // withAndroidRustlsPlatformVerifier",
				"    maven {",
				`      url '${RUSTLS_PLATFORM_VERIFIER.repository}'`,
				"      content {",
				"        includeGroup 'org.rustls'",
				"      }",
				"    }",
				"    google()"
			].join("\n")
		)
		// The buildscript repositories are untouched.
		expect(out.slice(0, out.indexOf("allprojects {"))).not.toContain("rustls")
		expect(addRustlsMavenRepository(out)).toBe(out)
	})

	it("throws when allprojects.repositories is missing (template shape changed)", () => {
		expect(() => addRustlsMavenRepository("buildscript {}\n")).toThrow(/allprojects.repositories/)
	})

	it("adds the pinned dependency to the app module once", () => {
		const out = addRustlsDependency("android {\n}\n")

		expect(out).toContain("implementation 'org.rustls:rustls-platform-verifier:0.2.0'")
		expect(addRustlsDependency(out)).toBe(out)
	})

	it("appends upstream's keep rule once", () => {
		const out = addRustlsProguardRule("# react-native-reanimated\n-keep class com.swmansion.reanimated.** { *; }\n\n")

		expect(PROGUARD_RULE).toBe("-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }")
		expect(out.endsWith(`\n\n# withAndroidRustlsPlatformVerifier\n${PROGUARD_RULE}\n`)).toBe(true)
		expect(addRustlsProguardRule(out)).toBe(out)
		expect(addRustlsProguardRule("")).toContain(PROGUARD_RULE)
	})
})

describe("CRL distribution point parsing", () => {
	function tlv(tag: number, content: number[]): number[] {
		return [tag, content.length, ...content]
	}

	function crlExtension(uris: string[], critical: boolean): Uint8Array {
		const distributionPoints = tlv(
			0x30,
			uris.flatMap(uri => tlv(0x30, tlv(0xa0, tlv(0xa0, tlv(0x86, [...Buffer.from(uri, "ascii")])))))
		)

		return new Uint8Array(
			tlv(0x30, [0x06, 0x03, 0x55, 0x1d, 0x1f, ...(critical ? tlv(0x01, [0xff]) : []), ...tlv(0x04, distributionPoints)])
		)
	}

	it("reads every URI of the extension", () => {
		expect(crlDistributionPoints(crlExtension(["http://yr1.c.lencr.org/108.crl", "http://crl.example.com/a.crl"], false))).toEqual([
			"http://yr1.c.lencr.org/108.crl",
			"http://crl.example.com/a.crl"
		])
	})

	it("skips the critical flag", () => {
		expect(crlDistributionPoints(crlExtension(["http://x1.c.lencr.org/"], true))).toEqual(["http://x1.c.lencr.org/"])
	})

	it("returns nothing for a certificate without the extension", () => {
		expect(crlDistributionPoints(new Uint8Array(tlv(0x30, [0x06, 0x03, 0x55, 0x1d, 0x0e])))).toEqual([])
	})
})
