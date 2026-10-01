import Foundation

/// The JavaScriptCore highlighter bundle for tests: built once per test run with
/// `bun ios/Tools/build-highlighter.ts` into ios/build/highlighter/, so it always matches the
/// checked-out highlight.ts. Set HARNESS_HIGHLIGHTER_JS to use a prebuilt file instead.
enum HighlighterScript {
    static let repoRoot = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // Support
        .deletingLastPathComponent() // HarnessKitTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // HarnessKit
        .deletingLastPathComponent() // ios
        .deletingLastPathComponent()

    /// The built script's URL, or the reason it couldn't be built.
    static let url: Result<URL, ScriptError> = build()

    struct ScriptError: Error, CustomStringConvertible {
        let description: String
    }

    private static func bun() -> String? {
        let env = ProcessInfo.processInfo.environment
        let path = (env["PATH"] ?? "").split(separator: ":").map { "\($0)/bun" }
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return (path + ["\(home)/.bun/bin/bun", "/opt/homebrew/bin/bun", "/usr/local/bin/bun"])
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func build() -> Result<URL, ScriptError> {
        if let prebuilt = ProcessInfo.processInfo.environment["HARNESS_HIGHLIGHTER_JS"] {
            return .success(URL(fileURLWithPath: prebuilt))
        }
        guard let bun = bun() else { return .failure(ScriptError(description: "bun isn't installed; it builds the highlighter bundle")) }
        let out = repoRoot.appending(path: "ios/build/highlighter/highlighter.js")
        let p = Process()
        p.executableURL = URL(fileURLWithPath: bun)
        p.arguments = ["ios/Tools/build-highlighter.ts", "--out", out.path]
        p.currentDirectoryURL = repoRoot
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        do {
            try p.run()
        } catch {
            return .failure(ScriptError(description: "couldn't run bun: \(error)"))
        }
        let log = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        p.waitUntilExit()
        guard p.terminationStatus == 0 else {
            return .failure(ScriptError(description: "build-highlighter failed (did you `bun install`?):\n\(log)"))
        }
        return .success(out)
    }

    static func source() throws -> String {
        try String(contentsOf: url.get(), encoding: .utf8)
    }
}
