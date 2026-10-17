import Foundation
import HarnessKit

/// The event stream, controlled by the test: connected from the start, and silent until `push`.
final class WorldSocket: EventSource, @unchecked Sendable {
    let events: AsyncStream<HarnessEvent>
    let status: AsyncStream<Bool>
    private let eventSink: AsyncStream<HarnessEvent>.Continuation
    private let statusSink: AsyncStream<Bool>.Continuation

    init() {
        (events, eventSink) = AsyncStream.makeStream(of: HarnessEvent.self)
        (status, statusSink) = AsyncStream.makeStream(of: Bool.self)
        statusSink.yield(true)
    }

    func push(_ event: HarnessEvent) { eventSink.yield(event) }

    func close() async {
        eventSink.finish()
        statusSink.finish()
    }
}
