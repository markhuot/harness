// swift-tools-version: 6.2
// L0 logic tests and L3 wire-contract tests for HarnessKit, through its public API only. Run by `bun run testing` (layer L0).
// A package of its own, so it needs no simulator and shares nothing with ios/HarnessKit/Tests.
import PackageDescription

let package = Package(
    name: "HarnessLogicTests",
    platforms: [.macOS(.v15)],
    dependencies: [.package(path: "../../ios/HarnessKit")],
    targets: [
        .testTarget(
            name: "LogicTests",
            dependencies: [.product(name: "HarnessKit", package: "HarnessKit")],
            path: "Tests/LogicTests"
        ),
        // L3: decodes the wire fixtures testing/contract generates from protocol.ts (run by
        // testing/contract/swift.test.ts, which sets HARNESS_CONTRACT_FIXTURES).
        .testTarget(
            name: "ContractTests",
            dependencies: [.product(name: "HarnessKit", package: "HarnessKit")],
            path: "Tests/ContractTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
