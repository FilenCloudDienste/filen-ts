import { spawn, type ChildProcess } from "node:child_process"
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as sleep } from "node:timers/promises"
import { type BoundedResult, errorMessage, fail, powershellBounded, psQuote, runBounded, waitFor } from "../support.ts"
import type { Platform } from "../targets.ts"
import { durationMs, encodeSteps, type Point, type Primitive, type Rect, xdotoolArgs } from "./dragInput.ts"

// Chain D's desktop on each OS (scripts/ci/e2e/chains/dragOut.ts): the file manager a drop lands in, both windows
// placed side by side, the app brought to the front, and real pointer input (dragInput.ts plans it). Every tool runs
// bounded, and a gesture's bound is its own length plus a margin.
//
//   Windows  SendInput through a C# helper in PowerShell (Add-Type), Explorer (CabinetWClass) on a directory, windows
//            placed with SetWindowPos; the screen raised to 1920x1080 when it is smaller (hosted runners start at
//            1024x768, too narrow for the app's 800 px beside Explorer)
//   macOS    CoreGraphics HID events from dragInput.swift, compiled here with swiftc (they need Accessibility, which the
//            runner may not grant: access() says, and the chain records it instead of failing); Finder on a directory
//            and both windows placed through System Events, which hosted runners allow osascript; the screen raised
//            like Windows' when the display offers a wider mode
//   Linux    xdotool (XTEST) under Xvfb with no window manager, Thunar on a directory (an X11 file manager that takes
//            XDND drops of text/uri-list); windows moved with xdotool, the app focused with windowfocus

const TOOL_TIMEOUT_MS = 60_000
const OPEN_TIMEOUT_MS = 60_000
// What a gesture's helper may take beyond its own pauses: starting (PowerShell compiles its C#), posting the events.
const GESTURE_MARGIN_MS = 45_000

export interface DragDesktop {
	readonly fileManager: string
	// OS units are device pixels (Windows, X11) rather than points (macOS): a page's CSS px times devicePixelRatio.
	readonly pixels: boolean
	// The menu bar, Dock or taskbar to keep both windows off.
	readonly insets: { top: number; bottom: number }
	// Once, before anything: builds the helper, sizes the screen. Returns what it did, for the findings.
	prepare(): Promise<string>
	// Whether posted input reaches other processes here; null when it does, else why not (macOS Accessibility).
	inputBlocked(): Promise<string | null>
	screen(): Promise<Rect>
	// Places the app's main window (process `pid`); returns where it is then.
	placeApp(pid: number, rect: Rect): Promise<Rect>
	// Opens the file manager on `dir` (closing the one before) and places its window; returns where it is.
	openTarget(dir: string, rect: Rect): Promise<Rect>
	closeTarget(): Promise<void>
	// The app's window to the front with the input focus (a press on an inactive window only activates it on macOS).
	focusApp(pid: number): Promise<void>
	perform(primitives: readonly Primitive[]): Promise<void>
	// What is under the pointer now, for the findings (Windows: the root window's class and process).
	underPointer(): Promise<string>
	// Whatever covers the app's window (process `pid`) at `at` ended, so input there reaches the app: what it did; null
	// where nothing is checked. Fails when the cover stays (Windows: a first-logon screen over the whole desktop).
	uncover(pid: number, at: Point): Promise<string | null>
	stop(): Promise<void>
}

function described(result: BoundedResult): string {
	return `${result.timedOut ? "timed out" : `exit ${String(result.status)}`}: ${result.stderr.trim().slice(-1500)}`
}

function rectOf(text: string, what: string): Rect {
	const match = /(-?\d+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s*$/.exec(text.trim())

	if (match === null) {
		fail(`${what}: no rectangle in "${text.trim().slice(-300)}"`)
	}

	return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) }
}

// ---- Windows

// SendInput with absolute coordinates over the virtual desktop, DPI-aware so they are device pixels; the windows by
// process and class; the screen's mode. C# 5 (Windows PowerShell's Add-Type).
const WIN_INPUT = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class FilenE2eDrag {
	[StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
	[StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
	[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
	[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
	[StructLayout(LayoutKind.Sequential)] struct GUITHREADINFO { public int cbSize; public int flags; public IntPtr hwndActive; public IntPtr hwndFocus; public IntPtr hwndCapture; public IntPtr hwndMenuOwner; public IntPtr hwndMoveSize; public IntPtr hwndCaret; public RECT rcCaret; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DEVMODE {
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
		public short dmSpecVersion; public short dmDriverVersion; public short dmSize; public short dmDriverExtra; public int dmFields;
		public int dmPositionX; public int dmPositionY; public int dmDisplayOrientation; public int dmDisplayFixedOutput;
		public short dmColor; public short dmDuplex; public short dmYResolution; public short dmTTOption; public short dmCollate;
		[MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
		public short dmLogPixels; public int dmBitsPerPel; public int dmPelsWidth; public int dmPelsHeight; public int dmDisplayFlags; public int dmDisplayFrequency;
		public int dmICMMethod; public int dmICMIntent; public int dmMediaType; public int dmDitherType; public int dmReserved1; public int dmReserved2; public int dmPanningWidth; public int dmPanningHeight;
	}
	delegate bool EnumProc(IntPtr hwnd, IntPtr param);
	[DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint count, INPUT[] inputs, int size);
	[DllImport("user32.dll")] static extern bool SetProcessDPIAware();
	[DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
	[DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr param);
	[DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder name, int max);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
	[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
	[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
	[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int command);
	[DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
	[DllImport("user32.dll")] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] static extern bool GetCursorPos(out POINT point);
	[DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
	[DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
	[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int mode, ref DEVMODE devmode);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettings(ref DEVMODE devmode, int flags);
	const uint MOVE = 0x0001, LEFTDOWN = 0x0002, LEFTUP = 0x0004, VIRTUALDESK = 0x4000, ABSOLUTE = 0x8000, KEYUP = 0x0002;
	static string Class(IntPtr hwnd) { var name = new StringBuilder(256); GetClassName(hwnd, name, 256); return name.ToString(); }
	static string Title(IntPtr hwnd) { var text = new StringBuilder(512); GetWindowText(hwnd, text, 512); return text.ToString(); }
	static uint Pid(IntPtr hwnd) { uint pid; GetWindowThreadProcessId(hwnd, out pid); return pid; }
	public static void Aware() { SetProcessDPIAware(); }
	public static string Screen() { return "0 0 " + GetSystemMetrics(0) + " " + GetSystemMetrics(1); }
	// The primary display's mode raised to width x height when it is smaller; what it was and what it is.
	public static string Raise(int width, int height) {
		var mode = new DEVMODE();
		mode.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE));
		if (!EnumDisplaySettings(null, -1, ref mode)) return "no current mode";
		string before = mode.dmPelsWidth + "x" + mode.dmPelsHeight;
		if (mode.dmPelsWidth >= width && mode.dmPelsHeight >= height) return before + ", kept";
		mode.dmPelsWidth = width; mode.dmPelsHeight = height; mode.dmFields = 0x80000 | 0x100000;
		int result = ChangeDisplaySettings(ref mode, 0);
		return before + " -> " + width + "x" + height + ": ChangeDisplaySettings " + result;
	}
	static void Send(INPUT input) {
		var inputs = new INPUT[] { input };
		if (SendInput(1, inputs, Marshal.SizeOf(typeof(INPUT))) != 1) throw new Exception("SendInput refused the event (error " + Marshal.GetLastWin32Error() + ")");
	}
	static void Mouse(uint flags, int x, int y) {
		int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78), height = GetSystemMetrics(79);
		var input = new INPUT();
		input.type = 0;
		input.u.mi.dx = (int)Math.Round((x - left) * 65535.0 / Math.Max(1, width - 1));
		input.u.mi.dy = (int)Math.Round((y - top) * 65535.0 / Math.Max(1, height - 1));
		input.u.mi.dwFlags = flags | MOVE | ABSOLUTE | VIRTUALDESK;
		Send(input);
	}
	static void Key(ushort vk, bool up) {
		var input = new INPUT();
		input.type = 1;
		input.u.ki.wVk = vk;
		input.u.ki.dwFlags = up ? KEYUP : 0;
		Send(input);
	}
	// The steps of dragInput.ts encodeSteps: m X Y, d, u, k esc, s MS.
	public static void Run(string steps) {
		POINT at; GetCursorPos(out at);
		int x = at.X, y = at.Y;
		foreach (string raw in steps.Split(';')) {
			string[] parts = raw.Trim().Split(new char[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
			if (parts.Length == 0) continue;
			switch (parts[0]) {
				case "m": x = int.Parse(parts[1]); y = int.Parse(parts[2]); Mouse(0, x, y); break;
				case "d": Mouse(LEFTDOWN, x, y); break;
				case "u": Mouse(LEFTUP, x, y); break;
				case "k": Key(0x1B, false); Thread.Sleep(30); Key(0x1B, true); break;
				case "s": Thread.Sleep(int.Parse(parts[1])); break;
				default: throw new Exception("bad step " + raw);
			}
		}
	}
	static IntPtr Find(Func<IntPtr, bool> match) {
		IntPtr found = IntPtr.Zero; int area = -1;
		EnumWindows((hwnd, param) => {
			if (!IsWindowVisible(hwnd) || !match(hwnd)) return true;
			RECT rect; GetWindowRect(hwnd, out rect);
			int size = (rect.Right - rect.Left) * (rect.Bottom - rect.Top);
			if (size > area) { area = size; found = hwnd; }
			return true;
		}, IntPtr.Zero);
		return found;
	}
	// The largest visible top-level window of process pid with that class.
	public static IntPtr OfProcess(uint pid, string cls) { return Find(h => Pid(h) == pid && Class(h) == cls); }
	// The largest visible top-level window of that class whose title holds the text.
	public static IntPtr Titled(string cls, string text) { return Find(h => Class(h) == cls && Title(h).Contains(text)); }
	public static string Place(IntPtr hwnd, int x, int y, int width, int height) {
		ShowWindow(hwnd, 9);
		SetWindowPos(hwnd, IntPtr.Zero, x, y, width, height, 0x0004 | 0x0040);
		RECT rect; GetWindowRect(hwnd, out rect);
		return rect.Left + " " + rect.Top + " " + (rect.Right - rect.Left) + " " + (rect.Bottom - rect.Top);
	}
	public static bool Front(IntPtr hwnd) { ShowWindow(hwnd, 9); return SetForegroundWindow(hwnd); }
	public static bool Close(IntPtr hwnd) { return PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero); }
	static string Owner(IntPtr hwnd) {
		if (hwnd == IntPtr.Zero) return "none";
		IntPtr root = GetAncestor(hwnd, 2);
		string name;
		try { name = System.Diagnostics.Process.GetProcessById((int)Pid(root)).ProcessName; } catch (Exception) { name = "?"; }
		return Class(hwnd) + " in root " + Class(root) + " of " + name + " " + Pid(root) + " '" + Title(root) + "'";
	}
	// What is under the pointer, the foreground window, and the window holding the mouse capture on its thread (which
	// takes every mouse message, whatever is under the pointer).
	public static string Under() {
		POINT at; GetCursorPos(out at);
		var info = new GUITHREADINFO();
		info.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
		string capture = GetGUIThreadInfo(0, ref info) ? Owner(info.hwndCapture) : "not read";
		return "at " + at.X + "," + at.Y + ": " + Owner(WindowFromPoint(at)) + "; foreground: " + Owner(GetForegroundWindow()) + "; capture: " + capture;
	}
	// Ends the processes whose top-level window covers x,y over process pid's, up to three (the windows-11-arm image
	// shows its first-logon privacy screen over the whole desktop); never the shell's or the session's own.
	public static string Uncover(uint pid, int x, int y) {
		var ended = new List<string>();
		string[] keep = { "explorer", "dwm", "csrss", "winlogon", "svchost", "sihost", "system", "idle", "?" };
		for (int round = 0; round < 4; round++) {
			POINT at; at.X = x; at.Y = y;
			IntPtr root = GetAncestor(WindowFromPoint(at), 2);
			uint owner = Pid(root);
			string after = ended.Count == 0 ? "" : " after ending " + string.Join(", ", ended);
			if (owner == pid) return ended.Count == 0 ? "nothing over the app" : "ended " + string.Join(", ", ended);
			string name;
			try { name = System.Diagnostics.Process.GetProcessById((int)owner).ProcessName; } catch (Exception) { name = "?"; }
			string what = name + " " + owner + " (" + Class(root) + " '" + Title(root) + "')";
			if (round == 3 || Array.IndexOf(keep, name.ToLowerInvariant()) >= 0) return "covered by " + what + after;
			try { System.Diagnostics.Process.GetProcessById((int)owner).Kill(); } catch (Exception error) { return "covered by " + what + after + ": " + error.Message; }
			ended.Add(what);
			Thread.Sleep(2000);
		}
		return "covered";
	}
}
`

// The helper is compiled once (prepare) into an assembly each later call loads, and a gesture's steps go through a
// file: an encoded command line holding the C# or a long gesture would pass Windows' 32,767-character limit.
function windowsDesktop(work: string): DragDesktop {
	const dir = path.join(work, "drag-input")
	const assembly = path.join(dir, "FilenE2eDrag.dll")
	let explorer: string | null = null
	let gestures = 0

	const winScript = async (what: string, body: string, timeoutMs = TOOL_TIMEOUT_MS): Promise<string> => {
		const result = await powershellBounded(`Add-Type -Path ${psQuote(assembly)}\n[FilenE2eDrag]::Aware()\n${body}`, timeoutMs)

		if (result.status !== 0) {
			fail(`${what}: ${described(result)}`)
		}

		return result.stdout.trim()
	}

	const closeTarget = async () => {
		if (explorer === null) {
			return
		}

		const leaf = explorer

		explorer = null
		await winScript(
			"close Explorer",
			`$h = [FilenE2eDrag]::Titled('CabinetWClass', ${psQuote(leaf)}); if ($h -ne [IntPtr]::Zero) { [void][FilenE2eDrag]::Close($h) }`
		)
	}

	return {
		fileManager: "Explorer",
		pixels: true,
		insets: { top: 0, bottom: 56 },
		async prepare() {
			const source = path.join(dir, "FilenE2eDrag.cs")

			mkdirSync(dir, { recursive: true })
			writeFileSync(source, WIN_INPUT)

			const built = await powershellBounded(
				`Add-Type -Path ${psQuote(source)} -OutputAssembly ${psQuote(assembly)} -OutputType Library`,
				3 * 60 * 1000
			)

			if (built.status !== 0) {
				fail(`compile the input helper: ${described(built)}`)
			}

			return `helper compiled; ${await winScript("raise the screen", "[FilenE2eDrag]::Raise(1920, 1080); Start-Sleep -Seconds 2; [FilenE2eDrag]::Screen()")}`
		},
		inputBlocked: async () => null,
		screen: async () => rectOf(await winScript("read the screen", "[FilenE2eDrag]::Screen()"), "the screen"),
		async placeApp(pid, rect) {
			const text = await waitFor("the app's window", OPEN_TIMEOUT_MS, async () => {
				const placed = await winScript(
					"place the app",
					`$h = [FilenE2eDrag]::OfProcess(${String(pid)}, 'Chrome_WidgetWin_1'); if ($h -eq [IntPtr]::Zero) { '' } else { [FilenE2eDrag]::Place($h, ${String(rect.x)}, ${String(rect.y)}, ${String(rect.width)}, ${String(rect.height)}) }`
				)

				return placed === "" ? null : placed
			})

			return rectOf(text, "the app's window")
		},
		async openTarget(dir, rect) {
			await closeTarget()

			const leaf = path.basename(dir)

			await winScript("open Explorer", `Start-Process -FilePath explorer.exe -ArgumentList ${psQuote(`"${dir}"`)}`)
			explorer = leaf

			const text = await waitFor(
				`an Explorer window on ${leaf}`,
				OPEN_TIMEOUT_MS,
				async () => {
					const placed = await winScript(
						"place Explorer",
						`$h = [FilenE2eDrag]::Titled('CabinetWClass', ${psQuote(leaf)}); if ($h -eq [IntPtr]::Zero) { '' } else { [FilenE2eDrag]::Place($h, ${String(rect.x)}, ${String(rect.y)}, ${String(rect.width)}, ${String(rect.height)}) }`
					)

					return placed === "" ? null : placed
				},
				1000
			)

			return rectOf(text, "Explorer's window")
		},
		closeTarget,
		async focusApp(pid) {
			await winScript(
				"bring the app to the front",
				`$h = [FilenE2eDrag]::OfProcess(${String(pid)}, 'Chrome_WidgetWin_1'); if ($h -ne [IntPtr]::Zero) { [FilenE2eDrag]::Front($h) }`
			)
		},
		async perform(primitives) {
			const steps = path.join(dir, `gesture-${String(++gestures)}.txt`)

			writeFileSync(steps, encodeSteps(primitives))
			await winScript(
				"send the input",
				`[FilenE2eDrag]::Run([System.IO.File]::ReadAllText(${psQuote(steps)}))`,
				durationMs(primitives) + GESTURE_MARGIN_MS
			)
		},
		underPointer: () => winScript("read what is under the pointer", "[FilenE2eDrag]::Under()"),
		async uncover(pid, at) {
			const result = await winScript(
				"uncover the app's window",
				`[FilenE2eDrag]::Uncover(${String(pid)}, ${String(at.x)}, ${String(at.y)})`
			)

			if (result.startsWith("covered")) {
				fail(`the app's window at ${String(at.x)},${String(at.y)} is ${result}`)
			}

			return result
		},
		stop: closeTarget
	}
}

// ---- macOS

const SWIFT_SOURCE = fileURLToPath(new URL("./dragInput.swift", import.meta.url))

async function osascript(what: string, script: string, args: readonly string[] = []): Promise<string> {
	const result = await runBounded("osascript", ["-", ...args], TOOL_TIMEOUT_MS, { input: script })

	if (result.status !== 0) {
		fail(`${what}: ${described(result)}`)
	}

	return result.stdout.trim()
}

// Places window 1 of a process (by name, or the window named argv 4) through System Events; prints where it is.
const PLACE = `
on run argv
	set processName to item 1 of argv
	set theX to (item 2 of argv) as integer
	set theY to (item 3 of argv) as integer
	set theWidth to (item 4 of argv) as integer
	set theHeight to (item 5 of argv) as integer
	set windowName to ""
	if (count of argv) > 5 then set windowName to item 6 of argv
	with timeout of 30 seconds
		tell application "System Events"
			tell process processName
				if windowName is "" then
					set theWindow to window 1
				else
					set theWindow to first window whose name is windowName
				end if
				set position of theWindow to {theX, theY}
				set size of theWindow to {theWidth, theHeight}
				set {px, py} to position of theWindow
				set {pw, ph} to size of theWindow
			end tell
		end tell
	end timeout
	return (px as text) & " " & (py as text) & " " & (pw as text) & " " & (ph as text)
end run
`

const CLOSE_FINDER_WINDOW = `
on run argv
	with timeout of 30 seconds
		tell application "System Events"
			tell process "Finder"
				repeat with theWindow in (windows whose name is (item 1 of argv))
					click (first button of theWindow whose subrole is "AXCloseButton")
				end repeat
			end tell
		end tell
	end timeout
	return "closed"
end run
`

const FRONT = `
with timeout of 30 seconds
	tell application "System Events"
		set frontmost of (first process whose unix id is (item 1 of argv as integer)) to true
	end tell
end timeout
`

function macDesktop(work: string): DragDesktop {
	const binary = path.join(work, "drag-input", "dragInput")
	let finder: string | null = null

	const helper = async (what: string, args: readonly string[], timeoutMs = TOOL_TIMEOUT_MS): Promise<string> => {
		const result = await runBounded(binary, args, timeoutMs, { display: `dragInput ${args[0] ?? ""}` })

		if (result.status !== 0) {
			fail(`${what}: ${described(result)}`)
		}

		return result.stdout.trim()
	}

	const closeTarget = async () => {
		if (finder === null) {
			return
		}

		const leaf = finder

		finder = null
		await osascript("close the Finder window", CLOSE_FINDER_WINDOW, [leaf]).catch((error: unknown) =>
			console.log(`closing the Finder window ${leaf}: ${errorMessage(error)}`)
		)
	}

	return {
		fileManager: "Finder",
		pixels: false,
		insets: { top: 60, bottom: 110 },
		async prepare() {
			mkdirSync(path.dirname(binary), { recursive: true })

			const built = await runBounded("xcrun", ["swiftc", "-O", "-o", binary, SWIFT_SOURCE], 5 * 60 * 1000)

			if (built.status !== 0) {
				fail(`swiftc dragInput.swift: ${described(built)}`)
			}

			// Hosted runners start at 1024x768, too narrow for the app's 800 points beside Finder.
			const raised = await helper("raise the screen", ["raise", "1920", "1080"])

			await sleep(2000)

			return `dragInput built with swiftc; access ${await helper("read the input access", ["access"])}; screen ${raised}`
		},
		async inputBlocked() {
			const access = JSON.parse(await helper("read the input access", ["access"])) as { trusted?: unknown; postEvents?: unknown }

			return access.trusted === true || access.postEvents === true
				? null
				: `the runner grants this process neither Accessibility nor event posting (${JSON.stringify(access)})`
		},
		async screen() {
			const bounds = JSON.parse(await helper("read the screen", ["screen"])) as Record<string, unknown>
			const figure = (name: string) => (typeof bounds[name] === "number" ? Math.round(bounds[name]) : fail(`screen: no ${name}`))

			return { x: figure("x"), y: figure("y"), width: figure("width"), height: figure("height") }
		},
		async placeApp(pid, rect) {
			await this.focusApp(pid)

			return rectOf(
				await osascript("place the app's window", PLACE, ["Filen", ...[rect.x, rect.y, rect.width, rect.height].map(String)]),
				"the app's window"
			)
		},
		async openTarget(dir, rect) {
			await closeTarget()

			const leaf = path.basename(dir)
			const opened = await runBounded("open", ["-a", "Finder", dir], OPEN_TIMEOUT_MS)

			if (opened.status !== 0) {
				fail(`open -a Finder: ${described(opened)}`)
			}

			finder = leaf

			const text = await waitFor(
				`a Finder window on ${leaf}`,
				OPEN_TIMEOUT_MS,
				() =>
					osascript("place the Finder window", PLACE, [
						"Finder",
						...[rect.x, rect.y, rect.width, rect.height].map(String),
						leaf
					]).catch(() => null),
				1000
			)

			return rectOf(text, "the Finder window")
		},
		closeTarget,
		async focusApp(pid) {
			await osascript("bring the app to the front", `on run argv\n${FRONT}\nend run\n`, [String(pid)])
			// AppKit activates on its next turn; a press before that only activates the window.
			await sleep(700)
		},
		async perform(primitives) {
			await helper("post the input", ["run", encodeSteps(primitives)], durationMs(primitives) + GESTURE_MARGIN_MS)
		},
		underPointer: async () => "not read on macOS",
		uncover: async () => null,
		stop: closeTarget
	}
}

// ---- Linux

async function xdotool(what: string, args: readonly string[], timeoutMs = TOOL_TIMEOUT_MS): Promise<string> {
	const result = await runBounded("xdotool", args, timeoutMs, {
		display: `xdotool ${args.slice(0, 6).join(" ")}${args.length > 6 ? " …" : ""}`
	})

	if (result.status !== 0) {
		fail(`${what}: ${described(result)}`)
	}

	return result.stdout.trim()
}

async function xWindows(args: readonly string[]): Promise<string[]> {
	const result = await runBounded("xdotool", ["search", "--onlyvisible", ...args], TOOL_TIMEOUT_MS)

	return result.status === 0 ? result.stdout.split("\n").filter(line => line.trim() !== "") : []
}

async function xGeometry(window: string): Promise<Rect> {
	const shell = await xdotool("read a window's geometry", ["getwindowgeometry", "--shell", window])
	const value = (name: string) => Number(new RegExp(`^${name}=(-?\\d+)$`, "m").exec(shell)?.[1] ?? fail(`no ${name} in ${shell}`))

	return { x: value("X"), y: value("Y"), width: value("WIDTH"), height: value("HEIGHT") }
}

// The largest of `windows`.
async function largest(windows: readonly string[]): Promise<string | null> {
	let found: { window: string; area: number } | null = null

	for (const window of windows) {
		const rect = await xGeometry(window).catch(() => null)
		const area = rect === null ? -1 : rect.width * rect.height

		if (rect !== null && (found === null || area > found.area)) {
			found = { window, area }
		}
	}

	return found?.window ?? null
}

async function xPlace(window: string, rect: Rect): Promise<Rect> {
	// No --sync: it waits for the exact size or place, which a window's own limits can refuse for good.
	await xdotool("size a window", ["windowsize", window, String(rect.width), String(rect.height)])
	await xdotool("move a window", ["windowmove", window, String(rect.x), String(rect.y)])
	await sleep(700)

	return xGeometry(window)
}

function linuxDesktop(work: string): DragDesktop {
	let thunar: ChildProcess | null = null

	const appWindow = async (pid: number) =>
		waitFor("the app's X window", OPEN_TIMEOUT_MS, async () => largest(await xWindows(["--pid", String(pid)])), 1000)

	const closeTarget = async () => {
		if (thunar === null) {
			return
		}

		thunar = null
		// Thunar keeps one instance per session (D-Bus); the next opens fresh.
		await runBounded("pkill", ["-x", "thunar"], TOOL_TIMEOUT_MS)
		await waitFor(
			"Thunar to exit",
			OPEN_TIMEOUT_MS,
			async () => ((await xWindows(["--class", "[Tt]hunar"])).length === 0 ? true : null),
			500
		).catch((error: unknown) => console.log(`Thunar: ${errorMessage(error)}`))
	}

	return {
		fileManager: "Thunar",
		pixels: true,
		insets: { top: 0, bottom: 0 },
		async prepare() {
			const version = await runBounded("thunar", ["--version"], TOOL_TIMEOUT_MS)

			if (version.status !== 0) {
				fail(`thunar --version: ${described(version)}`)
			}

			return `${version.stdout.split("\n")[0]?.trim() ?? "thunar"}; xdotool ${await xdotool("read xdotool's version", ["version"])}`
		},
		inputBlocked: async () => null,
		async screen() {
			const [width, height] = (await xdotool("read the screen", ["getdisplaygeometry"])).split(/\s+/).map(Number)

			return { x: 0, y: 0, width: width ?? fail("no screen width"), height: height ?? fail("no screen height") }
		},
		async placeApp(pid, rect) {
			return xPlace(await appWindow(pid), rect)
		},
		async openTarget(dir, rect) {
			await closeTarget()

			const log = path.join(work, "thunar.log")
			const fd = openSync(log, "a", 0o600)

			try {
				thunar = spawn("thunar", [dir], { detached: true, stdio: ["ignore", fd, fd], env: process.env })
				thunar.on("error", error => console.error(`thunar: ${error.message}`))
				thunar.unref()
			} finally {
				closeSync(fd)
			}

			const window = await waitFor(
				`a Thunar window on ${path.basename(dir)}`,
				OPEN_TIMEOUT_MS,
				async () => largest(await xWindows(["--class", "[Tt]hunar"])),
				1000
			)

			return xPlace(window, rect)
		},
		closeTarget,
		async focusApp(pid) {
			const window = await appWindow(pid)

			await xdotool("raise the app's window", ["windowraise", window])
			await xdotool("focus the app's window", ["windowfocus", "--sync", window])
		},
		async perform(primitives) {
			await xdotool("send the input", xdotoolArgs(primitives), durationMs(primitives) + GESTURE_MARGIN_MS)
		},
		underPointer: async () => xdotool("read the pointer", ["getmouselocation"]),
		uncover: async () => null,
		stop: closeTarget
	}
}

export function dragDesktopFor(platform: Platform, work: string): DragDesktop {
	switch (platform) {
		case "win":
			return windowsDesktop(work)
		case "mac":
			return macDesktop(work)
		case "linux":
			return linuxDesktop(work)
	}
}
