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

enum Outcome: Settlement {
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

	static func internalFailure(_ message: String) -> Outcome {
		Outcome(.internalFailure, message)
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

// A File Provider call's promise; an XPC connection attached to it is invalidated on settling.
typealias Pending = PendingPromise<Outcome>

extension PendingPromise where S == Outcome {
	// false when already settled; the caller then owns the connection.
	func attach(_ connection: NSXPCConnection) -> Bool {
		attach { connection.invalidate() }
	}
}

// Starts every call off the JS thread, one at a time: started concurrently, each would hold a GCD thread through
// the system's synchronous XPC setup.
private let queue = DispatchQueue(label: "io.filen.fp", qos: .utility)

// A promise whose work runs off the JS thread and settles through `Pending`.
func start(_ env: napi_env, _ work: @escaping @Sendable (Pending) -> Void) -> napi_value? {
	start(env, name: "filen-fp", queue: queue, work)
}
