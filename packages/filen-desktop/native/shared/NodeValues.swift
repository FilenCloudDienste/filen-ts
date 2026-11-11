import Foundation
import NodeAPI

// Node-API value and argument helpers shared by the Swift addons.

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

// A number argument; nil for anything else, NaN and the infinities included.
func numberArgument(_ env: napi_env, _ value: napi_value?) -> Double? {
	var type = napi_undefined
	var result = 0.0

	guard napi_typeof(env, value, &type) == napi_ok, type == napi_number, napi_get_value_double(env, value, &result) == napi_ok, result.isFinite else {
		return nil
	}

	return result
}

func booleanArgument(_ env: napi_env, _ value: napi_value?) -> Bool? {
	var type = napi_undefined
	var result = false

	guard napi_typeof(env, value, &type) == napi_ok, type == napi_boolean, napi_get_value_bool(env, value, &result) == napi_ok else {
		return nil
	}

	return result
}

func isNullish(_ env: napi_env, _ value: napi_value?) -> Bool {
	var type = napi_undefined

	return napi_typeof(env, value, &type) == napi_ok && (type == napi_null || type == napi_undefined)
}

func isFunction(_ env: napi_env, _ value: napi_value?) -> Bool {
	var type = napi_undefined

	return napi_typeof(env, value, &type) == napi_ok && type == napi_function
}

// A copy of a Uint8Array (a Buffer included) of at most maxBytes bytes; nil for anything else.
func bytesArgument(_ env: napi_env, _ value: napi_value?, maxBytes: Int) -> Data? {
	var isTypedArray = false
	var type = napi_int8_array
	var length = 0
	var bytes: UnsafeMutableRawPointer?

	guard
		napi_is_typedarray(env, value, &isTypedArray) == napi_ok, isTypedArray,
		napi_get_typedarray_info(env, value, &type, &length, &bytes, nil, nil) == napi_ok, type == napi_uint8_array, length <= maxBytes
	else {
		return nil
	}

	guard let bytes, length > 0 else {
		return Data()
	}

	return Data(bytes: bytes, count: length)
}

// Throws an Error carrying `code` into JS; the callback then returns nil.
func throwError(_ env: napi_env, code: String, _ message: String) -> napi_value? {
	napi_throw_error(env, code, message)

	return nil
}

// Sets each method on exports; false when Node-API refused one.
func defineMethods(_ env: napi_env, _ exports: napi_value?, _ methods: [(String, napi_callback)]) -> Bool {
	for (name, method) in methods {
		var function: napi_value?

		guard
			napi_create_function(env, name, name.utf8.count, method, nil, &function) == napi_ok,
			napi_set_named_property(env, exports, name, function) == napi_ok
		else {
			return false
		}
	}

	return true
}
