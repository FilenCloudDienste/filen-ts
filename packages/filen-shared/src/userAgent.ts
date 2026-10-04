// A small user-agent reader for activity logs: which browser or Filen app, on which OS, on what kind of
// device. Not a feature detector: a UA can lie, and an iPad in desktop mode reads as a Mac.

export type UserAgentDevice = "desktop" | "mobile" | "tablet" | "unknown"

export interface ParsedUserAgent {
	browser?: string
	browserVersion?: string
	os?: string
	osVersion?: string
	device: UserAgentDevice
	// One of Filen's own clients, or the HTTP library a script reached the API with.
	app?: string
}

interface AppRule {
	pattern: RegExp
	name: string
	// A Filen app's own UA: whatever browser engine it embeds is not one the user picked.
	filen: boolean
	// What the client implies when its UA names no OS.
	os?: string
}

// The desktop app is Electron, whose UA carries the app's package name; the legacy iOS app is a CFNetwork
// client named by its bundle, the legacy Android app an OkHttp one.
const APPS: readonly AppRule[] = [
	{ pattern: /(?:@filen\/desktop|filen-desktop)\/[\d.]+/i, name: "Filen Desktop", filen: true },
	{ pattern: /\bfilen-cli\b/i, name: "Filen CLI", filen: true },
	{ pattern: /^Filen\/[\w.]+ CFNetwork\//, name: "Filen", filen: true, os: "iOS" },
	{ pattern: /^okhttp\/[\d.]+/i, name: "OkHttp", filen: false, os: "Android" },
	{ pattern: /^axios\/[\d.]+/i, name: "axios", filen: false },
	{ pattern: /^(?:node-fetch|undici|node)\b/i, name: "Node.js", filen: false },
	{ pattern: /^curl\//i, name: "curl", filen: false },
	{ pattern: /^Wget\//i, name: "Wget", filen: false },
	{ pattern: /^python-requests\//i, name: "Python", filen: false }
]

// Every real UA fits, and a logged one is chosen by whoever sent it: the parser never reads past this.
export const USER_AGENT_MAX_LENGTH = 512

// Ordered: Chromium forks and Edge carry "Chrome/" too, every Chromium carries "Safari/", and Firefox or
// Chrome on iOS carry "Safari/" with no "Chrome/". The third entry is a second pattern the UA must also
// carry, tested apart: joined by `.*`, the two backtrack quadratically.
const BROWSERS: readonly (readonly [RegExp, string, RegExp?])[] = [
	[/\b(?:Edg|EdgA|EdgiOS|Edge)\/([\d.]+)/, "Edge"],
	[/\b(?:OPR|OPT)\/([\d.]+)/, "Opera"],
	[/\bOpera[/ ]([\d.]+)/, "Opera"],
	[/\bSamsungBrowser\/([\d.]+)/, "Samsung Internet"],
	[/\bVivaldi\/([\d.]+)/, "Vivaldi"],
	[/\bYaBrowser\/([\d.]+)/, "Yandex Browser"],
	[/\bBrave\/([\d.]+)/, "Brave"],
	[/\b(?:Firefox|FxiOS)\/([\d.]+)/, "Firefox"],
	[/\bCriOS\/([\d.]+)/, "Chrome"],
	[/\bElectron\/([\d.]+)/, "Electron"],
	[/\bChromium\/([\d.]+)/, "Chromium"],
	// Automation and scripted sign-ins; "\bChrome\/" can't match inside "HeadlessChrome/".
	[/\bHeadlessChrome\/([\d.]+)/, "Headless Chrome"],
	[/\bChrome\/([\d.]+)/, "Chrome"],
	[/\bVersion\/([\d.]+)/, "Safari", /\bSafari\//]
]

const WINDOWS_VERSIONS: Readonly<Record<string, string>> = {
	"10.0": "10",
	"6.3": "8.1",
	"6.2": "8",
	"6.1": "7",
	"6.0": "Vista",
	"5.1": "XP"
}

function osOf(os: string, device: UserAgentDevice, version: string | undefined): ParsedUserAgent {
	return version === undefined || version.length === 0 ? { os, device } : { os, osVersion: version.replaceAll("_", "."), device }
}

function readOs(ua: string): ParsedUserAgent {
	const windows = /\bWindows NT ([\d.]+)/.exec(ua)

	if (windows !== null) {
		const nt = windows[1] ?? ""

		return osOf("Windows", "desktop", WINDOWS_VERSIONS[nt] ?? nt)
	}

	if (/\bWindows\b/.test(ua)) {
		return { os: "Windows", device: "desktop" }
	}

	if (/\biPad\b/.test(ua)) {
		return osOf("iPadOS", "tablet", /\bOS ([\d_]+)/.exec(ua)?.[1])
	}

	if (/\b(?:iPhone|iPod)\b/.test(ua)) {
		return osOf("iOS", "mobile", /\bOS ([\d_]+)/.exec(ua)?.[1])
	}

	const android = /\bAndroid(?: ([\d.]+))?/.exec(ua)

	if (android !== null) {
		return osOf("Android", /\bMobile\b/.test(ua) ? "mobile" : "tablet", android[1])
	}

	if (/\bCrOS\b/.test(ua)) {
		return { os: "ChromeOS", device: "desktop" }
	}

	if (/\bMacintosh\b|\bMac OS X\b/.test(ua)) {
		return osOf("macOS", "desktop", /\bMac OS X ([\d_.]+)/.exec(ua)?.[1])
	}

	if (/\b(?:Linux|X11|Ubuntu|Fedora)\b/.test(ua)) {
		return { os: "Linux", device: "desktop" }
	}

	return { device: "unknown" }
}

// Fields a UA doesn't state are left out, never guessed.
export function parseUserAgent(ua: string | null | undefined): ParsedUserAgent {
	const value = ua?.slice(0, USER_AGENT_MAX_LENGTH).trim() ?? ""

	if (value.length === 0) {
		return { device: "unknown" }
	}

	const parsed = readOs(value)
	const app = APPS.find(rule => rule.pattern.test(value))

	if (app !== undefined) {
		parsed.app = app.name

		if (parsed.os === undefined && app.os !== undefined) {
			parsed.os = app.os
			parsed.device = "mobile"
		}

		if (app.filen) {
			return parsed
		}
	}

	for (const [pattern, name, requires] of BROWSERS) {
		const match = pattern.exec(value)

		if (match !== null && (requires === undefined || requires.test(value))) {
			parsed.browser = name

			if (match[1] !== undefined) {
				parsed.browserVersion = match[1]
			}

			break
		}
	}

	return parsed
}

export interface DeviceLabelStrings {
	browserOnOs: (browser: string, os: string) => string
	unknown: string
}

const DEFAULT_DEVICE_LABEL_STRINGS: DeviceLabelStrings = {
	browserOnOs: (browser, os) => `${browser} on ${os}`,
	unknown: "Unknown device"
}

// "Chrome on macOS", "Filen Desktop on Windows", or the half that is known. Versions stay out: they belong
// to a detail view, not a row.
export function deviceLabel(parsed: ParsedUserAgent, strings: DeviceLabelStrings = DEFAULT_DEVICE_LABEL_STRINGS): string {
	const client = parsed.app ?? parsed.browser

	if (client !== undefined && parsed.os !== undefined) {
		return strings.browserOnOs(client, parsed.os)
	}

	return client ?? parsed.os ?? strings.unknown
}
