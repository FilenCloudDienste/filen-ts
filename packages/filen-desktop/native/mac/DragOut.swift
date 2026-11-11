import AppKit
import Foundation
import NodeAPI
import UniformTypeIdentifiers

// Drag-out to Finder: an OS drag of file promises started from the window's current mouse location. Finder asks for
// each item at a URL it supplies (writePromiseTo, on promiseQueue); JS downloads there and answers with fulfil. JS calls
// arrive on the main thread, AppKit's; callbacks go back through one threadsafe function each, which JS receives also
// while AppKit tracks the drag.

private let maxItems = 10_000
private let maxNameBytes = 255
private let maxPathBytes = 4096
private let maxErrorBytes = 1024
private let maxImageBytes = 2 << 20
private let maxImagePoints = 4096.0
// Frames drawn for the stack; the others ride along undrawn.
private let drawnItems = 5
private let stackOffset: CGFloat = 8
// Doubles hold integers exactly up to here.
private let maxSafeInteger = Double(1 << 53)

private let errorDomain = "FilenMac"

// Finder's writes: each returns at once, so one queue serves every drag.
private let promiseQueue: OperationQueue = {
	let queue = OperationQueue()

	queue.name = "io.filen.mac.promise"
	queue.qualityOfService = .userInitiated

	return queue
}()

// MARK: Callbacks into JS

private enum Argument {
	case number(Double)
	case string(String)
}

private final class Arguments {
	let values: [Argument]
	// Runs instead when the call never reaches JS (the environment shuts down).
	let undelivered: (@Sendable () -> Void)?

	init(_ values: [Argument], undelivered: (@Sendable () -> Void)?) {
		self.values = values
		self.undelivered = undelivered
	}
}

// Runs on the JS thread; env is nil while the function is torn down, when the call is undelivered.
private func invoke(env: napi_env?, function: napi_value?, _: UnsafeMutableRawPointer?, data: UnsafeMutableRawPointer?) {
	guard let data else {
		return
	}

	let arguments = Unmanaged<Arguments>.fromOpaque(data).takeRetainedValue()

	guard let env, let function else {
		arguments.undelivered?()

		return
	}

	var argv: [napi_value?] = arguments.values.map { value in
		switch value {
		case .number(let number):
			var result: napi_value?

			napi_create_double(env, number, &result)

			return result
		case .string(let text):
			return string(env, text)
		}
	}
	var undefined: napi_value?

	napi_get_undefined(env, &undefined)
	napi_call_function(env, undefined, function, argv.count, &argv, nil)
}

// Node-API finalized the function (released, or the environment shut down): it is never called again.
private func finalized(env _: napi_env?, data: UnsafeMutableRawPointer?, hint _: UnsafeMutableRawPointer?) {
	guard let data else {
		return
	}

	Unmanaged<Callback>.fromOpaque(data).takeRetainedValue().markFinalized()?()
}

// One JS function callable from any thread. It does not keep Node's event loop alive.
private final class Callback: @unchecked Sendable {
	private var tsfn: napi_threadsafe_function?
	private let lock = NSLock()
	private var usable = true
	private var onFinalize: (@Sendable () -> Void)?

	// nil when Node-API refused the function.
	init?(_ env: napi_env, _ function: napi_value?, name: String) {
		let retained = Unmanaged.passRetained(self)
		var tsfn: napi_threadsafe_function?

		guard
			napi_create_threadsafe_function(
				env, function, nil, string(env, name), 0, 1, retained.toOpaque(), finalized, nil, invoke, &tsfn
			) == napi_ok,
			let tsfn
		else {
			retained.release()

			return nil
		}

		self.tsfn = tsfn
		napi_unref_threadsafe_function(env, tsfn)
	}

	// Returns the hook to run once the lock is let go.
	fileprivate func markFinalized() -> (@Sendable () -> Void)? {
		lock.lock()
		defer { lock.unlock() }

		let hook = onFinalize

		usable = false
		tsfn = nil
		onFinalize = nil

		return hook
	}

	// Runs once the function is finalized: after release, or when the environment shuts down.
	func whenFinalized(_ hook: @escaping @Sendable () -> Void) {
		lock.lock()
		onFinalize = hook
		lock.unlock()
	}

	// Anything but napi_ok means JS will not hear of it.
	@discardableResult
	func call(_ values: [Argument], undelivered: (@Sendable () -> Void)? = nil) -> napi_status {
		lock.lock()
		defer { lock.unlock() }

		guard usable, let tsfn else {
			return napi_closing
		}

		let arguments = Unmanaged.passRetained(Arguments(values, undelivered: undelivered))
		let status = napi_call_threadsafe_function(tsfn, arguments.toOpaque(), napi_tsfn_nonblocking)

		if status != napi_ok {
			arguments.release()
		}

		return status
	}

	// Calls already queued still run.
	func release() {
		lock.lock()
		defer { lock.unlock() }

		guard usable, let tsfn else {
			return
		}

		usable = false
		napi_release_threadsafe_function(tsfn, napi_tsfn_release)
	}
}

// MARK: Sessions

// One drag: its callbacks and whether each item is done with them. The callbacks are released once the drag ended and
// every item was written and fulfilled or its provider was deallocated unwritten, since Finder may ask after the end.
private final class DragSession: NSObject, NSFilePromiseProviderDelegate, NSDraggingSource, @unchecked Sendable {
	private let onWrite: Callback
	private let onCancel: Callback
	private let onEnded: Callback
	private let lock = NSLock()
	private var ended = false
	private var released = false
	// Writes JS has not fulfilled yet, and per item whether no further write is expected (written, or the provider is
	// gone), with a count of the items still expecting one.
	private var openWrites = 0
	private var settled: [Bool]
	private var unsettled: Int

	init(items: Int, onWrite: Callback, onCancel: Callback, onEnded: Callback) {
		self.onWrite = onWrite
		self.onCancel = onCancel
		self.onEnded = onEnded
		settled = Array(repeating: false, count: items)
		unsettled = items
		super.init()
		// Without JS no write is fulfilled: Finder must not wait on them.
		onWrite.whenFinalized { [weak self] in
			if let self {
				tickets.failAll(of: self)
			}
		}
	}

	var hasEnded: Bool {
		lock.lock()
		defer { lock.unlock() }

		return ended
	}

	deinit {
		releaseCallbacks()
	}

	private func releaseCallbacks() {
		onWrite.release()
		onCancel.release()
		onEnded.release()
	}

	// Under the lock.
	private func releaseIfDone() {
		guard ended, !released, openWrites == 0, unsettled == 0 else {
			return
		}

		released = true
		releaseCallbacks()
	}

	// Under the lock.
	private func settle(_ index: Int) {
		if !settled[index] {
			settled[index] = true
			unsettled -= 1
		}

		releaseIfDone()
	}

	// false when the callbacks are gone: the write fails at once.
	func opened() -> Bool {
		lock.lock()
		defer { lock.unlock() }

		guard !released else {
			return false
		}

		openWrites += 1

		return true
	}

	func closed(_ index: Int) {
		lock.lock()
		defer { lock.unlock() }

		openWrites -= 1
		settle(index)
	}

	func providerGone(_ index: Int) {
		lock.lock()
		defer { lock.unlock() }

		settle(index)
	}

	func write(_ ticket: Int, _ index: Int, _ path: String) -> napi_status {
		onWrite.call([.number(Double(ticket)), .number(Double(index)), .string(path)]) {
			tickets.fulfil(ticket, error: "unavailable")
		}
	}

	func cancelled(_ ticket: Int) {
		onCancel.call([.number(Double(ticket))])
	}

	// MARK: NSFilePromiseProviderDelegate

	@MainActor
	func filePromiseProvider(_ provider: NSFilePromiseProvider, fileNameForType _: String) -> String {
		(provider as? PromiseProvider)?.name ?? "Untitled"
	}

	@MainActor
	func operationQueue(for _: NSFilePromiseProvider) -> OperationQueue {
		promiseQueue
	}

	// On promiseQueue. Returns at once; the completion runs when JS fulfils the ticket.
	func filePromiseProvider(_ provider: NSFilePromiseProvider, writePromiseTo url: URL, completionHandler: @escaping (Error?) -> Void) {
		guard let provider = provider as? PromiseProvider, url.isFileURL, opened() else {
			completionHandler(writeError("unavailable"))

			return
		}

		let ticket = tickets.open(session: self, index: provider.index, url: url, completion: completionHandler)

		if write(ticket, provider.index, url.path) != napi_ok {
			tickets.fulfil(ticket, error: "unavailable")
		}
	}

	// MARK: NSDraggingSource

	@MainActor
	func draggingSession(_: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation {
		context == .outsideApplication ? .copy : []
	}

	@MainActor
	func draggingSession(_: NSDraggingSession, endedAt _: NSPoint, operation: NSDragOperation) {
		if activeDrag?.session === self {
			activeDrag = nil
		}

		onEnded.call([.string(operation.contains(.copy) ? "copy" : "none")])
		lock.lock()
		ended = true
		releaseIfDone()
		lock.unlock()
	}
}

// One item's promise. It keeps its session alive, as NSFilePromiseProvider holds its delegate weakly and Finder may ask
// after the drag ended.
private final class PromiseProvider: NSFilePromiseProvider, @unchecked Sendable {
	let index: Int
	let name: String
	let session: DragSession

	init(index: Int, name: String, fileType: String, session: DragSession) {
		self.index = index
		self.name = name
		self.session = session
		super.init()
		self.fileType = fileType
		delegate = session
	}

	deinit {
		session.providerGone(index)
	}
}

// The drag AppKit tracks; stale once AppKit let go of its dragging session without an end.
private struct ActiveDrag {
	let session: DragSession
	weak var dragging: NSDraggingSession?
}

@MainActor private var activeDrag: ActiveDrag?

// MARK: Tickets

// What a write completes with: "cancelled" as the user's cancel, so Finder shows no alert for it.
private func writeError(_ code: String) -> Error {
	guard code != "cancelled" else {
		return CocoaError(.userCancelled)
	}

	return NSError(domain: errorDomain, code: 1, userInfo: [NSLocalizedDescriptionKey: "Filen could not download this item (\(code))."])
}

private final class Ticket {
	let session: DragSession
	let index: Int
	let completion: (Error?) -> Void
	let onCancel: @Sendable () -> Void
	var progress: Progress

	init(session: DragSession, index: Int, completion: @escaping (Error?) -> Void, onCancel: @escaping @Sendable () -> Void, progress: Progress) {
		self.session = session
		self.index = index
		self.completion = completion
		self.onCancel = onCancel
		self.progress = progress
	}
}

// Finder's file progress at `url`: a bar and a cancel button on the file's icon while it is published.
private func publishedProgress(_ url: URL, total: Int64, completed: Int64, onCancel: @escaping @Sendable () -> Void) -> Progress {
	let progress = Progress(totalUnitCount: total)

	progress.completedUnitCount = completed
	progress.kind = .file
	progress.fileOperationKind = .downloading
	progress.fileURL = url
	progress.isCancellable = true
	progress.cancellationHandler = onCancel
	progress.publish()

	return progress
}

// Every open write of every session, by ticket.
private final class Tickets: @unchecked Sendable {
	private let lock = NSLock()
	private var open: [Int: Ticket] = [:]
	private var next = 1

	func open(session: DragSession, index: Int, url: URL, completion: @escaping (Error?) -> Void) -> Int {
		lock.lock()
		defer { lock.unlock() }

		let ticket = next
		let onCancel: @Sendable () -> Void = { [weak session] in session?.cancelled(ticket) }

		next += 1
		open[ticket] = Ticket(
			session: session,
			index: index,
			completion: completion,
			onCancel: onCancel,
			progress: publishedProgress(url, total: -1, completed: 0, onCancel: onCancel)
		)

		return ticket
	}

	func moveProgress(_ ticket: Int, to url: URL) {
		lock.lock()
		defer { lock.unlock() }

		guard let entry = open[ticket] else {
			return
		}

		let old = entry.progress

		// Finder cancelled it: a new one would show the bar again, and its cancel is already reported.
		guard !old.isCancelled else {
			return
		}

		old.unpublish()
		entry.progress = publishedProgress(url, total: old.totalUnitCount, completed: old.completedUnitCount, onCancel: entry.onCancel)
	}

	func progress(_ ticket: Int, completed: Int64, total: Int64) {
		lock.lock()
		defer { lock.unlock() }

		guard let progress = open[ticket]?.progress else {
			return
		}

		if progress.totalUnitCount != total {
			progress.totalUnitCount = total
		}

		progress.completedUnitCount = completed
	}

	func failAll(of session: DragSession) {
		lock.lock()

		let owned = open.filter { $0.value.session === session }.map(\.key)

		lock.unlock()

		for ticket in owned {
			fulfil(ticket, error: "unavailable")
		}
	}

	// The first call per ticket completes Finder's write; any later one is ignored.
	func fulfil(_ ticket: Int, error: String?) {
		lock.lock()

		let entry = open.removeValue(forKey: ticket)

		lock.unlock()

		guard let entry else {
			return
		}

		entry.progress.unpublish()
		entry.completion(error.map(writeError))
		entry.session.closed(entry.index)
	}
}

private let tickets = Tickets()

// MARK: Exports

private struct Item {
	let name: String
	let fileType: String
}

// One path component a file system takes as is.
private func isComponent(_ name: String) -> Bool {
	name != "." && name != ".." && !name.contains("/") && !name.contains("\0")
}

// The UTType a promise may carry: a directory, or a data type (anything else makes AppKit throw).
private func fileType(directory: Bool, contentType: String?) -> String {
	if directory {
		return UTType.folder.identifier
	}

	guard let contentType, let type = UTType(contentType), type.conforms(to: .data) else {
		return UTType.data.identifier
	}

	return type.identifier
}

private func items(_ env: napi_env, _ value: napi_value?) -> [Item]? {
	guard let elements = arrayElements(env, value), (1 ... maxItems).contains(elements.count) else {
		return nil
	}

	var items: [Item] = []

	items.reserveCapacity(elements.count)

	for element in elements {
		guard
			let element,
			let name = stringArgument(env, property(env, element, "name"), maxBytes: maxNameBytes), isComponent(name),
			let directory = booleanArgument(env, property(env, element, "directory"))
		else {
			return nil
		}

		let contentType = property(env, element, "contentType")
		let type: String?

		if isNullish(env, contentType) {
			type = nil
		} else {
			guard let text = stringArgument(env, contentType, maxBytes: maxNameBytes) else {
				return nil
			}

			type = text
		}

		items.append(Item(name: name, fileType: fileType(directory: directory, contentType: type)))
	}

	return items
}

// The 8-byte NSView pointer of BrowserWindow.getNativeWindowHandle(); nil for any other buffer.
private func viewHandle(_ env: napi_env, _ value: napi_value?) -> UInt? {
	guard let bytes = bytesArgument(env, value, maxBytes: 8), bytes.count == 8 else {
		return nil
	}

	let handle = bytes.withUnsafeBytes { UInt(UInt64(littleEndian: $0.loadUnaligned(as: UInt64.self))) }

	return handle == 0 ? nil : handle
}

private func dimension(_ env: napi_env, _ value: napi_value?) -> CGFloat? {
	guard let number = numberArgument(env, value), number > 0, number <= maxImagePoints else {
		return nil
	}

	return CGFloat(number)
}

private func ticketArgument(_ env: napi_env, _ value: napi_value?) -> Int? {
	guard let number = numberArgument(env, value), number >= 0, number <= maxSafeInteger, number.rounded() == number else {
		return nil
	}

	return Int(number)
}

private func countArgument(_ env: napi_env, _ value: napi_value?) -> Int64? {
	ticketArgument(env, value).map(Int64.init)
}

private func arguments(_ env: napi_env, _ info: napi_callback_info?, _ count: Int) -> [napi_value?]? {
	var argc = count
	var argv = [napi_value?](repeating: nil, count: count)

	guard napi_get_cb_info(env, info, &argc, &argv, nil, nil) == napi_ok else {
		return nil
	}

	return argv
}

private func invalid(_ env: napi_env, _ message: String) -> napi_value? {
	throwError(env, code: "invalidArgument", message)
}

private struct DragFailure: Sendable {
	let code: String
	let message: String
}

// Starts the drag; nil once AppKit tracks it.
@MainActor private func startDrag(
	_ env: napi_env,
	handle: UInt,
	items: [Item],
	picture: NSImage,
	size: NSSize,
	callbacks: (onWrite: napi_value?, onCancel: napi_value?, onEnded: napi_value?)
) -> DragFailure? {
	if let active = activeDrag {
		guard active.dragging == nil else {
			return DragFailure(code: "busy", message: "a drag is running")
		}

		activeDrag = nil
	}

	// Only an open window's content view is used: a handle of a closed window would point at freed memory.
	guard let view = contentView(handle) else {
		return DragFailure(code: "invalidArgument", message: "view is no open window's content view")
	}

	// The page's drag ended before the call: AppKit would start a drag that no button holds.
	guard NSEvent.pressedMouseButtons & 1 != 0 else {
		return DragFailure(code: "buttonReleased", message: "the primary mouse button is not held")
	}

	guard let window = view.window else {
		return DragFailure(code: "internalFailure", message: "the view has no window")
	}

	let location = window.mouseLocationOutsideOfEventStream

	// AppKit starts a drag from a mouse-dragged event of this window, stamped now; the page's events are not AppKit's.
	guard
		let event = NSEvent.mouseEvent(
			with: .leftMouseDragged,
			location: location,
			modifierFlags: [],
			timestamp: ProcessInfo.processInfo.systemUptime,
			windowNumber: window.windowNumber,
			context: nil,
			eventNumber: 0,
			clickCount: 1,
			pressure: 1
		)
	else {
		return DragFailure(code: "internalFailure", message: "could not create the drag event")
	}

	let created = [
		Callback(env, callbacks.onWrite, name: "filen-mac-write"),
		Callback(env, callbacks.onCancel, name: "filen-mac-cancel"),
		Callback(env, callbacks.onEnded, name: "filen-mac-ended")
	]

	guard let onWrite = created[0], let onCancel = created[1], let onEnded = created[2] else {
		for callback in created {
			callback?.release()
		}

		return DragFailure(code: "internalFailure", message: "could not create a threadsafe function")
	}

	let session = DragSession(items: items.count, onWrite: onWrite, onCancel: onCancel, onEnded: onEnded)
	let origin = view.convert(location, from: nil)

	picture.size = size

	let draggingItems = items.enumerated().map { index, item in
		let draggingItem = NSDraggingItem(pasteboardWriter: PromiseProvider(index: index, name: item.name, fileType: item.fileType, session: session))
		let offset = CGFloat(min(index, drawnItems - 1)) * stackOffset
		let frame = NSRect(x: origin.x - size.width / 2 + offset, y: origin.y - size.height / 2 - offset, width: size.width, height: size.height)

		draggingItem.setDraggingFrame(frame, contents: index < drawnItems ? picture : nil)

		return draggingItem
	}

	// AppKit declares a session always; one it does not give is a drag that never started.
	let dragging: NSDraggingSession? = view.beginDraggingSession(with: draggingItems, event: event, source: session)

	guard let dragging else {
		return DragFailure(code: "internalFailure", message: "AppKit started no drag")
	}

	if !session.hasEnded {
		activeDrag = ActiveDrag(session: session, dragging: dragging)
	}

	dragging.animatesToStartingPositionsOnCancelOrFail = true
	dragging.draggingFormation = .stack

	return nil
}

// The content view of an open window whose pointer is `handle`, compared without dereferencing it.
@MainActor private func contentView(_ handle: UInt) -> NSView? {
	let app: NSApplication? = NSApp

	return app?.windows.lazy.compactMap(\.contentView).first { UInt(bitPattern: Unmanaged.passUnretained($0).toOpaque()) == handle }
}

// begin({ view, items, image, onWrite, onCancel, onEnded }): starts the drag and returns at once.
private func begin(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard let options = objectArgument(env, info) else {
		return invalid(env, "expected an options object")
	}

	guard let handle = viewHandle(env, property(env, options, "view")) else {
		return invalid(env, "view must be an 8-byte, non-zero native window handle")
	}

	guard let items = items(env, property(env, options, "items")) else {
		return invalid(env, "items must be 1 to \(maxItems) of { name, directory, contentType }, each name one path component")
	}

	guard
		let image = property(env, options, "image"),
		let png = bytesArgument(env, property(env, image, "png"), maxBytes: maxImageBytes),
		let width = dimension(env, property(env, image, "width")),
		let height = dimension(env, property(env, image, "height")),
		let picture = NSImage(data: png), picture.isValid
	else {
		return invalid(env, "image must be { png, width, height }: a PNG of at most 2 MiB, sized in points")
	}

	let onWrite = property(env, options, "onWrite")
	let onCancel = property(env, options, "onCancel")
	let onEnded = property(env, options, "onEnded")

	guard isFunction(env, onWrite), isFunction(env, onCancel), isFunction(env, onEnded) else {
		return invalid(env, "onWrite, onCancel and onEnded must be functions")
	}

	guard Thread.isMainThread else {
		return throwError(env, code: "internalFailure", "begin must run on the main thread")
	}

	// assumeIsolated runs the closure at once on this thread, so the JS values never leave it.
	nonisolated(unsafe) let js = (env: env, callbacks: (onWrite: onWrite, onCancel: onCancel, onEnded: onEnded))
	let failure = MainActor.assumeIsolated {
		startDrag(js.env, handle: handle, items: items, picture: picture, size: NSSize(width: width, height: height), callbacks: js.callbacks)
	}

	if let failure {
		return throwError(env, code: failure.code, failure.message)
	}

	return nil
}

// progressAt(ticket, path): moves the ticket's progress to the file being written.
private func progressAt(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard
		let argv = arguments(env, info, 2),
		let ticket = ticketArgument(env, argv[0]),
		let path = stringArgument(env, argv[1], maxBytes: maxPathBytes), path.hasPrefix("/")
	else {
		return invalid(env, "expected a ticket and an absolute path")
	}

	tickets.moveProgress(ticket, to: URL(fileURLWithPath: path))

	return nil
}

// progress(ticket, completed, total)
private func progress(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard
		let argv = arguments(env, info, 3),
		let ticket = ticketArgument(env, argv[0]),
		let completed = countArgument(env, argv[1]),
		let total = countArgument(env, argv[2])
	else {
		return invalid(env, "expected a ticket and two byte counts")
	}

	tickets.progress(ticket, completed: completed, total: total)

	return nil
}

// fulfil(ticket, error: string | null)
private func fulfil(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	guard let argv = arguments(env, info, 2), let ticket = ticketArgument(env, argv[0]) else {
		return invalid(env, "expected a ticket")
	}

	let error: String?

	if isNullish(env, argv[1]) {
		error = nil
	} else {
		guard let code = stringArgument(env, argv[1], maxBytes: maxErrorBytes) else {
			return invalid(env, "error must be a string or null")
		}

		error = code
	}

	tickets.fulfil(ticket, error: error)

	return nil
}

let dragOutMethods: [(String, napi_callback)] = [
	("begin", begin),
	("progressAt", progressAt),
	("progress", progress),
	("fulfil", fulfil)
]
