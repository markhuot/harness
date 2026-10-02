#if os(macOS)
import Foundation
import Testing
@testable import HarnessKit

/// Runs HarnessClient and HarnessSocket against the real service (`bun service/src/daemon.ts`) in a
/// throwaway HARNESS_HOME with the dummy driver. Opt in: `HARNESS_INTEGRATION=1 swift test --filter Integration`.
@Suite("Integration: real daemon", .enabled(if: ProcessInfo.processInfo.environment["HARNESS_INTEGRATION"] == "1"), .serialized)
struct IntegrationTests {
    /// ios/HarnessKit/Tests/HarnessKitTests/Client/IntegrationTests.swift → the repo root.
    static let repoRoot: URL = {
        var url = URL(fileURLWithPath: #filePath)
        for _ in 0..<6 { url.deleteLastPathComponent() }
        return url
    }()

    @Test func restAndLiveEventsAgainstTheDaemon() async throws {
        let daemon = try Daemon.start()
        defer { daemon.stop() }
        let client = try await daemon.client()

        let health = try await client.health()
        #expect(health.ok)
        #expect(health.pid == Int(daemon.process.processIdentifier))

        #expect(try await client.listProjects() == [])

        let projectDir = daemon.home.appendingPathComponent("project", isDirectory: true)
        try FileManager.default.createDirectory(at: projectDir, withIntermediateDirectories: true)
        let project = try await client.createProject(CreateProjectBody(path: projectDir.path, name: "Swift Port", key: "SWIFT", defaultDriver: .value("dummy")))
        #expect(project.key == "SWIFT")
        #expect(try await client.listProjects().map(\.id) == [project.id])

        let first = try await client.createTicket(CreateTicketBody(projectId: project.id, spec: "First ticket", title: "First", driver: "dummy", start: false))
        #expect(first.key == "SWIFT-1")
        #expect(try await client.getTicket(first.key).ticket.title == "First")

        // A remote-ID miss is a 404 HarnessAPIError.
        let missing = try await #require(throws: HarnessAPIError.self) { try await client.getTicket("NOPE-999") }
        #expect(missing.status == 404)

        // Live events: connect, wait for the open, then change things and see them arrive.
        let socket = client.connect()
        defer { Task { await socket.close() } }
        let status = Recorder(socket.status)
        let events = Recorder(socket.events)
        await eventually("socket open", timeout: .seconds(10)) { status.items.contains(true) }

        let second = try await client.createTicket(CreateTicketBody(projectId: project.id, spec: "Second ticket", title: "Second", driver: "dummy", start: false))
        let secondKey = second.key
        await eventually("ticket.upserted for \(secondKey)", timeout: .seconds(5)) {
            events.items.contains { if case let .ticketUpserted(t) = $0 { t.key == secondKey } else { false } }
        }

        _ = try await client.updateTicket(first.key, UpdateTicketBody(title: "First, renamed"))
        await eventually("rename of SWIFT-1 arrives", timeout: .seconds(5)) {
            events.items.contains { if case let .ticketUpserted(t) = $0 { t.key == "SWIFT-1" && t.title == "First, renamed" } else { false } }
        }

        await socket.close()
        await eventually("socket streams finish") { status.finished && events.finished }
        #expect(status.items.first == true)
        #expect(status.items.last == false)
    }

    @Test func badTokenIs401() async throws {
        let daemon = try Daemon.start()
        defer { daemon.stop() }
        _ = try await daemon.client() // waits for /health
        let bad = HarnessClient(baseUrl: daemon.baseUrl, token: "not-the-token")
        // /health is public; everything else needs the token.
        #expect(try await bad.health().ok)
        let err = try await #require(throws: HarnessAPIError.self) { try await bad.listProjects() }
        #expect(err.status == 401)
        #expect(err.message == "Unauthorized")
    }
}

/// The daemon in a temp HARNESS_HOME on a free port. `stop()` terminates it and removes the home.
final class Daemon: @unchecked Sendable {
    let process: Process
    let home: URL
    let port: Int
    var baseUrl: String { "http://127.0.0.1:\(port)" }

    private init(process: Process, home: URL, port: Int) {
        self.process = process
        self.home = home
        self.port = port
    }

    static func start() throws -> Daemon {
        let home = FileManager.default.temporaryDirectory.appendingPathComponent("harness-ios-it-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: home, withIntermediateDirectories: true)
        let port = try freePort()
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["bun", IntegrationTests.repoRoot.appendingPathComponent("service/src/daemon.ts").path]
        p.currentDirectoryURL = IntegrationTests.repoRoot
        var env = ProcessInfo.processInfo.environment
        env["HARNESS_HOME"] = home.path
        env["HARNESS_PORT"] = String(port)
        env["HARNESS_DUMMY_DRIVER"] = "1"
        env["HARNESS_DUMMY_DELAY_MS"] = "1"
        // bun is usually in ~/.bun/bin, which a test runner's PATH may lack.
        let bunBin = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".bun/bin").path
        env["PATH"] = [bunBin, "/opt/homebrew/bin", "/usr/local/bin", env["PATH"] ?? "/usr/bin:/bin"].joined(separator: ":")
        p.environment = env
        FileManager.default.createFile(atPath: home.appendingPathComponent("daemon.log").path, contents: nil)
        let log = try FileHandle(forWritingTo: home.appendingPathComponent("daemon.log"))
        p.standardOutput = log
        p.standardError = log
        try p.run()
        return Daemon(process: p, home: home, port: port)
    }

    /// Waits for /health, then a client with the token the daemon wrote.
    func client() async throws -> HarnessClient {
        let probe = HarnessClient(baseUrl: baseUrl, token: "")
        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(20)
        while true {
            if (try? await probe.health()) != nil { break }
            guard process.isRunning, clock.now < deadline else {
                let log = (try? String(contentsOf: home.appendingPathComponent("daemon.log"), encoding: .utf8)) ?? ""
                throw DaemonError.notReady(log)
            }
            try await Task.sleep(for: .milliseconds(50))
        }
        let token = try String(contentsOf: home.appendingPathComponent("token"), encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        return HarnessClient(baseUrl: baseUrl, token: token)
    }

    func stop() {
        if process.isRunning {
            process.terminate()
            let deadline = Date().addingTimeInterval(10)
            while process.isRunning && Date() < deadline { usleep(20_000) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        }
        try? FileManager.default.removeItem(at: home)
    }

    /// Bind port 0 on loopback and read back the port the kernel picked.
    static func freePort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw DaemonError.noPort }
        defer { close(fd) }
        var addr = sockaddr_in()
        addr.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = 0
        addr.sin_addr.s_addr = inet_addr("127.0.0.1")
        var len = socklen_t(MemoryLayout<sockaddr_in>.size)
        let bound = withUnsafeMutablePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, len) == 0 && getsockname(fd, $0, &len) == 0 }
        }
        guard bound else { throw DaemonError.noPort }
        return Int(UInt16(bigEndian: addr.sin_port))
    }
}

enum DaemonError: Error, CustomStringConvertible {
    case noPort
    case notReady(String)
    var description: String {
        switch self {
        case .noPort: "couldn't find a free port"
        case let .notReady(log): "the daemon never answered /health. Log:\n\(log)"
        }
    }
}
#endif
