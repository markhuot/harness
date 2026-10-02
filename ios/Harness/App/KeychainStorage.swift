import Foundation
import HarnessKit
import Security

/// The iOS Keychain as AppModel's SecureStorage: generic passwords under one service, readable
/// after the first unlock (expo-secure-store's AFTER_FIRST_UNLOCK), keyed exactly like the RN
/// app's entries (`harness.servers`, `harness.prefs`, `harness.token.<id>`).
///
/// The service name differs from Expo's, so the native app keeps its own copy, but `get` migrates
/// one way from the RN app it replaces (same bundle id, so the same default access group): when
/// the native service has no item for a key, it reads the RN item, copies it into the native
/// service and returns it. The RN item is only ever read, never changed or deleted. The Debug
/// "Harness Dev" build has another bundle id (so another access group) and never sees RN items.
struct KeychainStorage: SecureStorage {
    struct KeychainError: Error, LocalizedError {
        let status: OSStatus
        var errorDescription: String? {
            (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)"
        }
    }

    var service = "com.markhuot.harness.native"

    /// Where expo-secure-store (v57, ios/SecureStoreModule.swift `query(with:)`) keeps an item:
    /// service `keychainService ?? "app"` plus `:no-auth` (the RN app never sets
    /// requireAuthentication), the key's UTF-8 bytes as both kSecAttrAccount and
    /// kSecAttrGeneric, and the value's UTF-8 bytes as the data. Items written by expo-secure-store
    /// before the suffix existed use the bare "app" service, which Expo still reads as a fallback.
    /// The `:auth` variant is skipped: reading it would prompt for Face ID, and the RN app never
    /// wrote one.
    static let legacyServices = ["app:no-auth", "app"]

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    private static func legacyQuery(_ key: String, service: String) -> [String: Any] {
        let encodedKey = Data(key.utf8)
        return [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrGeneric as String: encodedKey,
            kSecAttrAccount as String: encodedKey,
        ]
    }

    /// The data for `query`, nil when there's no such item.
    private static func copyData(_ query: [String: Any]) throws -> Data? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return out as? Data
    }

    func get(_ key: String) throws -> String? {
        if let data = try Self.copyData(query(key)) {
            return String(data: data, encoding: .utf8)
        }
        guard let value = legacyValue(key) else { return nil }
        // Best effort: a failed copy still returns the value, and the next get migrates again.
        try? set(key, value)
        return value
    }

    /// The RN app's value for `key`, read only. A Keychain error here counts as "no RN item", so a
    /// broken legacy entry never stops the native app from loading.
    private func legacyValue(_ key: String) -> String? {
        for legacy in Self.legacyServices {
            if let data = (try? Self.copyData(Self.legacyQuery(key, service: legacy))) ?? nil,
               let value = String(data: data, encoding: .utf8) {
                return value
            }
        }
        return nil
    }

    func set(_ key: String, _ value: String) throws {
        let data = Data(value.utf8)
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        var status = SecItemUpdate(query(key) as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(key).merging(attrs) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    /// Deletes the native item only. The RN item stays, so a later `get` of the same key would
    /// migrate it again; AppModel only deletes the token of a server it has just dropped from
    /// `harness.servers`, and never reads that token again.
    func delete(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}
