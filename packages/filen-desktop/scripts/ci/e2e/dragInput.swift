// Chain D's real pointer input on macOS (scripts/ci/e2e/dragDesktop.ts compiles it on the runner with swiftc):
// CoreGraphics HID events, so AppKit sees the stream a physical mouse produces. Posting them needs Accessibility,
// which a hosted runner may not grant this binary; `access` says what the system reports.
//
//   dragInput access        {"trusted","postEvents"}: AXIsProcessTrusted and CGPreflightPostEventAccess
//   dragInput screen        the main display's bounds in global points (top-left origin)
//   dragInput raise W H     the main display switched to its smallest mode of at least W x H points (else its widest)
//                           when it is smaller, for this login session; what it was, the modes, what it is
//   dragInput run "<steps>" m X Y (a move; a drag while the button is down), d, h (the button is still held from the
//                           last run), u, k esc, s MS; separated by ";"
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func emit(_ fields: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), let text = String(data: data, encoding: .utf8) {
		print(text)
		fflush(stdout)
	}
}

struct Failure: Error, CustomStringConvertible {
	let description: String
}

let source = CGEventSource(stateID: .hidSystemState)
// A drag goes on across runs: the button may still be down from the last one. The caller says so with "h": the HID
// state read here is recorded, not trusted (a move posted as mouseMoved under a held drag confuses AppKit's drag loop).
let buttonAtStart = CGEventSource.buttonState(.hidSystemState, button: .left)
var buttonDown = buttonAtStart
var cursor = CGEvent(source: nil)?.location ?? .zero
// The frontmost app when Escape went down (key events go to it), in the run's output.
var escapeTo: [String] = []

func post(_ type: CGEventType, _ point: CGPoint) {
	guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return }
	if type != .mouseMoved {
		event.setIntegerValueField(.mouseEventClickState, value: 1)
	}
	event.post(tap: .cghidEventTap)
	cursor = point
}

// Held for about 100 ms with the pointer jittering, as a key pressed during a drag: AppKit's drag loop hears the key
// between motion events (a 30 ms press under a resting pointer left a hosted runner's drag running).
func escape() {
	let base = cursor
	let front = NSWorkspace.shared.frontmostApplication
	escapeTo.append("\(front?.bundleIdentifier ?? front?.localizedName ?? "none") \(front?.processIdentifier ?? 0)")
	CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: true)?.post(tap: .cghidEventTap)
	for frame in 0 ..< 6 {
		Thread.sleep(forTimeInterval: 0.016)
		post(buttonDown ? .leftMouseDragged : .mouseMoved, CGPoint(x: base.x + (frame % 2 == 0 ? 1 : 0), y: base.y))
	}
	post(buttonDown ? .leftMouseDragged : .mouseMoved, base)
	CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: false)?.post(tap: .cghidEventTap)
}

func step(_ raw: String) throws {
	let parts = raw.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
	switch parts.first {
	case "m":
		guard parts.count == 3, let x = Double(parts[1]), let y = Double(parts[2]) else { throw Failure(description: "bad step \(raw)") }
		post(buttonDown ? .leftMouseDragged : .mouseMoved, CGPoint(x: x, y: y))
	case "d":
		post(.leftMouseDown, cursor)
		buttonDown = true
	case "h":
		buttonDown = true
	case "u":
		post(.leftMouseUp, cursor)
		buttonDown = false
	case "k":
		guard parts.count == 2, parts[1] == "esc" else { throw Failure(description: "bad step \(raw)") }
		escape()
	case "s":
		guard parts.count == 2, let ms = Double(parts[1]) else { throw Failure(description: "bad step \(raw)") }
		Thread.sleep(forTimeInterval: ms / 1000)
	case nil:
		break
	default:
		throw Failure(description: "bad step \(raw)")
	}
}

let argv = Array(CommandLine.arguments.dropFirst())

do {
	switch argv.first {
	case "access":
		emit(["trusted": AXIsProcessTrusted(), "postEvents": CGPreflightPostEventAccess()])
	case "screen":
		let bounds = CGDisplayBounds(CGMainDisplayID())
		emit(["x": bounds.origin.x, "y": bounds.origin.y, "width": bounds.width, "height": bounds.height])
	case "raise":
		guard argv.count == 3, let width = Int(argv[1]), let height = Int(argv[2]) else { throw Failure(description: "raise W H") }
		let display = CGMainDisplayID()
		let before = CGDisplayBounds(display)
		let size = { (bounds: CGRect) in "\(Int(bounds.width))x\(Int(bounds.height))" }
		if Int(before.width) >= width && Int(before.height) >= height {
			emit(["before": size(before), "after": size(before), "result": "kept"])
			break
		}
		let options = [kCGDisplayShowDuplicateLowResolutionModes: kCFBooleanTrue] as CFDictionary
		let modes = (CGDisplayCopyAllDisplayModes(display, options) as? [CGDisplayMode]) ?? []
		let fitting = modes.filter { $0.width >= width && $0.height >= height }.min { $0.width * $0.height < $1.width * $1.height }
		var result = "no wider mode"
		if let mode = fitting ?? modes.max(by: { $0.width < $1.width }), mode.width > Int(before.width) {
			var config: CGDisplayConfigRef?
			let began = CGBeginDisplayConfiguration(&config)
			if began == .success {
				_ = CGConfigureDisplayWithDisplayMode(config, display, mode, nil)
				let completed = CGCompleteDisplayConfiguration(config, .forSession)
				result = "\(mode.width)x\(mode.height): CGCompleteDisplayConfiguration \(completed.rawValue)"
			} else {
				result = "CGBeginDisplayConfiguration \(began.rawValue)"
			}
		}
		let listed = Array(Set(modes.map { "\($0.width)x\($0.height)" })).sorted()
		emit(["before": size(before), "after": size(CGDisplayBounds(display)), "result": result, "modes": listed])
	case "run":
		guard argv.count == 2 else { throw Failure(description: "run \"<steps>\"") }
		for raw in argv[1].split(separator: ";") {
			try step(raw.trimmingCharacters(in: .whitespaces))
		}
		var ran: [String: Any] = ["ran": true, "buttonAtStart": buttonAtStart, "buttonDown": buttonDown]
		if !escapeTo.isEmpty {
			ran["escapeTo"] = escapeTo
		}
		emit(ran)
	default:
		throw Failure(description: "usage: dragInput access | screen | run \"<steps>\"")
	}
} catch {
	FileHandle.standardError.write("dragInput: \(error)\n".data(using: .utf8) ?? Data())
	exit(1)
}
