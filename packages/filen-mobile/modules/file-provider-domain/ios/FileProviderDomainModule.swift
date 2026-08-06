import ExpoModulesCore
import FileProvider

/**
 Registration of the Filen `NSFileProviderDomain`, and nothing else.

 A replicated `NSFileProviderExtension` has no implicit default domain: unless the containing app
 registers one, the system never instantiates the extension and nothing shows up in Files.app.
 The rest of the app-side contract — the sealed auth.json the extension reads — already lives in
 `src/features/settings/authFileKey.ts`; see the module README.
 */
public final class FileProviderDomainModule: Module {
	public func definition() -> ModuleDefinition {
		Name("FileProviderDomain")

		// Adding a domain that is already registered is a no-op, so callers may repeat this freely.
		AsyncFunction("registerDomain") { (identifier: String, displayName: String) in
			try await NSFileProviderManager.add(
				NSFileProviderDomain(
					identifier: NSFileProviderDomainIdentifier(identifier),
					displayName: displayName
				)
			)
		}

		// `remove` takes the domain object, so look it up by identifier. Not finding it means there
		// is nothing to remove, which is the desired end state anyway.
		AsyncFunction("unregisterDomain") { (identifier: String) in
			guard let domain = try await findDomain(identifier) else {
				return
			}

			try await NSFileProviderManager.remove(domain)
		}

		AsyncFunction("isDomainRegistered") { (identifier: String) -> Bool in
			try await findDomain(identifier) != nil
		}
	}
}

private func findDomain(_ identifier: String) async throws -> NSFileProviderDomain? {
	try await NSFileProviderManager.domains().first { $0.identifier.rawValue == identifier }
}
