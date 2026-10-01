import Foundation
import HarnessKit
import Security

/// The iOS Keychain as AppModel's SecureStorage: generic passwords under one service, readable
/// after the first unlock (expo-secure-store's AFTER_FIRST_UNLOCK), keyed exactly like the RN
/// app's entries (`harness.servers`, `harness.prefs`, `harness.token.<id>`). The service name
/// differs from Expo's, so the two apps don't share pairings.
struct KeychainStorage: SecureStorage {
    struct KeychainError: Error, LocalizedError {
        let status: OSStatus
        var errorDescription: String? {
            (SecCopyErrorMessageString(status, nil) as String?) ?? "Keychain error \(status)"
        }
    }

    var service = "com.markhuot.harness.native"

    private func query(_ key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }

    func get(_ key: String) throws -> String? {
        var q = query(key)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return (out as? Data).flatMap { String(data: $0, encoding: .utf8) }
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

    func delete(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }
}
