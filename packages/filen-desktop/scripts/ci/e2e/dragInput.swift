// Chain D's real pointer input on macOS (scripts/ci/e2e/dragDesktop.ts compiles it on the runner with swiftc):
// CoreGraphics HID events, so AppKit sees the stream a physical mouse produces. Posting them needs Accessibility,
// which a hosted runner may not grant this binary; `access` says what the system reports.
//
//   dragInput access        {"trusted","postEvents"}: AXIsProcessTrusted and CGPreflightPostEventAccess
//   dragInput screen        the main display's bounds in global points (top-left origin)
//   dragInput run "<steps>" m X Y (a move; a drag while the button is down), d, u, k esc, s MS; separated by ";"
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
// A drag goes on across runs: the button may still be down from the last one.
var buttonDown = CGEventSource.buttonState(.hidSystemState, button: .left)
var cursor = CGEvent(source: nil)?.location ?? .zero

func post(_ type: CGEventType, _ point: CGPoint) {
	guard let event = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: .left) else { return }
	if type != .mouseMoved {
		event.setIntegerValueField(.mouseEventClickState, value: 1)
	}
	event.post(tap: .cghidEventTap)
	cursor = point
}

func escape() {
	CGEvent(keyboardEventSource: source, virtualKey: 53, keyDown: true)?.post(tap: .cghidEventTap)
	Thread.sleep(forTimeInterval: 0.03)
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
	case "run":
		guard argv.count == 2 else { throw Failure(description: "run \"<steps>\"") }
		for raw in argv[1].split(separator: ";") {
			try step(raw.trimmingCharacters(in: .whitespaces))
		}
		emit(["ran": true, "buttonDown": buttonDown])
	default:
		throw Failure(description: "usage: dragInput access | screen | run \"<steps>\"")
	}
} catch {
	FileHandle.standardError.write("dragInput: \(error)\n".data(using: .utf8) ?? Data())
	exit(1)
}
