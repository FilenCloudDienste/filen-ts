import Foundation
import NodeAPI

// The macOS addon filen-mac.node: quarantine for downloads (the work runs off the JS thread and settles a promise) and
// drag-out to Finder (DragOut.swift). Arguments are read on the calling JS thread.

private let maxPathBytes = 4096

// Marks one call at a time, in call order.
private let queue = DispatchQueue(label: "io.filen.mac", qos: .utility)

enum Outcome: Settlement {
	case done
	// Rejects with an Error carrying `code` and, for quarantineFailed, `failures`: how many paths of the call failed.
	case failure(code: String, message: String, failures: Int)

	static func internalFailure(_ message: String) -> Outcome {
		.failure(code: "internalFailure", message: message, failures: 0)
	}

	static func invalidArgument(_ message: String) -> Outcome {
		.failure(code: "invalidArgument", message: message, failures: 0)
	}

	func settle(_ env: napi_env, _ deferred: napi_deferred) {
		switch self {
		case .done:
			var undefined: napi_value?

			napi_get_undefined(env, &undefined)
			napi_resolve_deferred(env, deferred, undefined)
		case .failure(let code, let message, let failures):
			var error: napi_value?
			var number: napi_value?

			napi_create_error(env, string(env, code), string(env, message), &error)

			if failures > 0 {
				napi_create_int64(env, Int64(failures), &number)
				napi_set_named_property(env, error, "failures", number)
			}

			napi_reject_deferred(env, deferred, error)
		}
	}
}

// The elements of an array argument; nil when it is not an array.
func arrayElements(_ env: napi_env, _ value: napi_value?) -> [napi_value?]? {
	var isArray = false
	var length: UInt32 = 0

	guard napi_is_array(env, value, &isArray) == napi_ok, isArray, napi_get_array_length(env, value, &length) == napi_ok else {
		return nil
	}

	var elements: [napi_value?] = []

	elements.reserveCapacity(Int(length))

	for index in 0 ..< length {
		var element: napi_value?

		guard napi_get_element(env, value, index, &element) == napi_ok else {
			return nil
		}

		elements.append(element)
	}

	return elements
}

// quarantine(paths: string[]): Promise<void>, marks each path as downloaded; after trying every one, rejects naming the
// first path that failed and counting the failures.
private func quarantinePaths(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	var argc = 1
	var argv: napi_value?

	guard napi_get_cb_info(env, info, &argc, &argv, nil, nil) == napi_ok, let elements = arrayElements(env, argv) else {
		return rejected(env, Outcome.invalidArgument("expected an array of paths"))
	}

	var paths: [String] = []

	paths.reserveCapacity(elements.count)

	for element in elements {
		guard let path = stringArgument(env, element, maxBytes: maxPathBytes) else {
			return rejected(env, Outcome.invalidArgument("each path must be a string of 1 to 4096 UTF-8 bytes"))
		}

		paths.append(path)
	}

	return start(env, name: "filen-mac", queue: queue) { [paths] (pending: PendingPromise<Outcome>) in
		guard let failure = quarantine(paths) else {
			pending.settle(.done)

			return
		}

		pending.settle(.failure(code: "quarantineFailed", message: failure.first, failures: failure.failures))
	}
}

@_cdecl("napi_register_module_v1")
public func registerModule(env: napi_env?, exports: napi_value?) -> napi_value? {
	guard let env else {
		return nil
	}

	let methods: [(String, napi_callback)] = [("quarantine", quarantinePaths)] + dragOutMethods

	return defineMethods(env, exports, methods) ? exports : nil
}
