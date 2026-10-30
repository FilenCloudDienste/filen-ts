import Foundation
import NodeAPI

// Errors raised by the addon itself; system and extension errors keep their NSError domain and code.
let addonErrorDomain = "FilenFileProvider"

enum AddonError: Int {
	case invalidArgument = 1
	case domainUnavailable = 2
	case serviceUnavailable = 3
	case timedOut = 4
	case internalFailure = 5
}

struct DomainInfo: Sendable {
	let identifier: String
	let displayName: String
	let userEnabled: Bool
}

enum Outcome: Sendable {
	case done
	case domains([DomainInfo])
	case failure(domain: String, code: Int, message: String)

	init(_ error: Error) {
		let error = error as NSError

		self = .failure(domain: error.domain, code: error.code, message: error.localizedDescription)
	}

	init(_ error: AddonError, _ message: String) {
		self = .failure(domain: addonErrorDomain, code: error.rawValue, message: message)
	}

	// Resolves or rejects on the JS thread.
	func settle(_ env: napi_env, _ deferred: napi_deferred) {
		switch self {
		case .done:
			var undefined: napi_value?

			napi_get_undefined(env, &undefined)
			napi_resolve_deferred(env, deferred, undefined)
		case .domains(let domains):
			var array: napi_value?

			napi_create_array_with_length(env, domains.count, &array)

			for (index, domain) in domains.enumerated() {
				var object: napi_value?

				napi_create_object(env, &object)
				napi_set_named_property(env, object, "identifier", string(env, domain.identifier))
				napi_set_named_property(env, object, "displayName", string(env, domain.displayName))
				napi_set_named_property(env, object, "userEnabled", boolean(env, domain.userEnabled))
				napi_set_element(env, array, UInt32(index), object)
			}

			napi_resolve_deferred(env, deferred, array)
		case .failure(let domain, let code, let message):
			var error: napi_value?
			var number: napi_value?

			napi_create_error(env, nil, string(env, message), &error)
			napi_create_int64(env, Int64(code), &number)
			napi_set_named_property(env, error, "domain", string(env, domain))
			napi_set_named_property(env, error, "code", number)
			napi_reject_deferred(env, deferred, error)
		}
	}
}

func string(_ env: napi_env, _ value: String) -> napi_value? {
	var result: napi_value?

	napi_create_string_utf8(env, value, value.utf8.count, &result)

	return result
}

func boolean(_ env: napi_env, _ value: Bool) -> napi_value? {
	var result: napi_value?

	napi_get_boolean(env, value, &result)

	return result
}

// One outcome on its way to the JS thread.
private final class Delivery {
	let deferred: napi_deferred
	let outcome: Outcome

	init(deferred: napi_deferred, outcome: Outcome) {
		self.deferred = deferred
		self.outcome = outcome
	}
}

// Runs on the JS thread; env is nil while the function is torn down, when only the delivery is freed.
private func deliver(env: napi_env?, _: napi_value?, _: UnsafeMutableRawPointer?, data: UnsafeMutableRawPointer?) {
	guard let data else {
		return
	}

	let delivery = Unmanaged<Delivery>.fromOpaque(data).takeRetainedValue()

	if let env {
		delivery.outcome.settle(env, delivery.deferred)
	}
}

// A promise settled from any thread, exactly once. Its threadsafe function is released on settling; an XPC connection
// attached to it is invalidated then.
final class Pending: @unchecked Sendable {
	private let deferred: napi_deferred
	private let tsfn: napi_threadsafe_function
	private let lock = NSLock()
	private var settled = false
	private var connection: NSXPCConnection?

	fileprivate init(deferred: napi_deferred, tsfn: napi_threadsafe_function) {
		self.deferred = deferred
		self.tsfn = tsfn
	}

	// false when already settled; the caller then owns the connection.
	func attach(_ connection: NSXPCConnection) -> Bool {
		lock.withLock {
			guard !settled else {
				return false
			}

			self.connection = connection

			return true
		}
	}

	func settle(_ outcome: Outcome) {
		lock.lock()

		let first = !settled
		let connection = self.connection

		settled = true
		self.connection = nil
		lock.unlock()

		guard first else {
			return
		}

		connection?.invalidate()

		let delivery = Unmanaged.passRetained(Delivery(deferred: deferred, outcome: outcome))

		// Fails only while the environment shuts down, when nothing is left to settle.
		if napi_call_threadsafe_function(tsfn, delivery.toOpaque(), napi_tsfn_nonblocking) != napi_ok {
			delivery.release()
		}

		napi_release_threadsafe_function(tsfn, napi_tsfn_release)
	}
}

// A promise rejected before any work starts.
func rejected(_ env: napi_env, _ outcome: Outcome) -> napi_value? {
	var deferred: napi_deferred?
	var promise: napi_value?

	guard napi_create_promise(env, &deferred, &promise) == napi_ok, let deferred else {
		return nil
	}

	outcome.settle(env, deferred)

	return promise
}

// Starts every call off the JS thread, one at a time: started concurrently, each would hold a GCD thread through
// the system's synchronous XPC setup.
private let queue = DispatchQueue(label: "io.filen.fp", qos: .utility)

// A promise whose work runs off the JS thread and settles through `Pending`.
func start(_ env: napi_env, _ work: @escaping @Sendable (Pending) -> Void) -> napi_value? {
	var deferred: napi_deferred?
	var promise: napi_value?
	var tsfn: napi_threadsafe_function?

	guard napi_create_promise(env, &deferred, &promise) == napi_ok, let deferred else {
		return nil
	}

	guard
		napi_create_threadsafe_function(env, nil, nil, string(env, "filen-fp"), 0, 1, nil, nil, nil, deliver, &tsfn) == napi_ok,
		let tsfn
	else {
		Outcome(.internalFailure, "Could not create a threadsafe function").settle(env, deferred)

		return promise
	}

	let pending = Pending(deferred: deferred, tsfn: tsfn)

	queue.async {
		work(pending)
	}

	return promise
}

// The call's single object argument; nil when it is missing or not an object.
func objectArgument(_ env: napi_env, _ info: napi_callback_info?) -> napi_value? {
	var argc = 1
	var argv: napi_value?
	var type = napi_undefined

	guard napi_get_cb_info(env, info, &argc, &argv, nil, nil) == napi_ok, napi_typeof(env, argv, &type) == napi_ok, type == napi_object else {
		return nil
	}

	return argv
}

// A property of an object argument; undefined when absent, which no reader accepts.
func property(_ env: napi_env, _ object: napi_value, _ name: String) -> napi_value? {
	var value: napi_value?

	return napi_get_named_property(env, object, name, &value) == napi_ok ? value : nil
}

// A string argument of 1...maxBytes UTF-8 bytes, as raw bytes; nil for anything else.
func utf8Argument(_ env: napi_env, _ value: napi_value?, maxBytes: Int) -> Data? {
	var type = napi_undefined
	var length = 0

	guard
		napi_typeof(env, value, &type) == napi_ok, type == napi_string,
		napi_get_value_string_utf8(env, value, nil, 0, &length) == napi_ok, length > 0, length <= maxBytes
	else {
		return nil
	}

	var data = Data(count: length + 1)
	let status = data.withUnsafeMutableBytes { buffer in
		napi_get_value_string_utf8(env, value, buffer.baseAddress?.assumingMemoryBound(to: CChar.self), length + 1, &length)
	}

	guard status == napi_ok else {
		return nil
	}

	// Drops the terminating NUL.
	data.count = length

	return data
}

func stringArgument(_ env: napi_env, _ value: napi_value?, maxBytes: Int) -> String? {
	utf8Argument(env, value, maxBytes: maxBytes).map { String(decoding: $0, as: UTF8.self) }
}
