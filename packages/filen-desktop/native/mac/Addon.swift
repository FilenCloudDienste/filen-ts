import Foundation
import NodeAPI

// The macOS addon filen-mac.node: quarantine for downloads. Every export runs on the calling JS thread.

private let maxPathBytes = 4096

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

// quarantine(paths: string[]): marks each path as downloaded; throws naming the first path that failed, after trying
// every one.
private func quarantinePaths(env: napi_env?, info: napi_callback_info?) -> napi_value? {
	guard let env else {
		return nil
	}

	var argc = 1
	var argv: napi_value?

	guard napi_get_cb_info(env, info, &argc, &argv, nil, nil) == napi_ok, let elements = arrayElements(env, argv) else {
		return throwError(env, code: "invalidArgument", "expected an array of paths")
	}

	var paths: [String] = []

	paths.reserveCapacity(elements.count)

	for element in elements {
		guard let path = stringArgument(env, element, maxBytes: maxPathBytes) else {
			return throwError(env, code: "invalidArgument", "each path must be a string of 1 to 4096 UTF-8 bytes")
		}

		paths.append(path)
	}

	if let failure = quarantine(paths) {
		return throwError(env, code: "quarantineFailed", failure)
	}

	return nil
}

@_cdecl("napi_register_module_v1")
public func registerModule(env: napi_env?, exports: napi_value?) -> napi_value? {
	guard let env else {
		return nil
	}

	let methods: [(String, napi_callback)] = [
		("quarantine", quarantinePaths)
	]

	return defineMethods(env, exports, methods) ? exports : nil
}
