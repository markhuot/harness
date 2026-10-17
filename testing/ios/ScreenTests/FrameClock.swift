import QuartzCore
import UIKit

/// Waits for the next frame the display draws, so rendering waits on the screen's own cadence
/// instead of a fixed delay.
@MainActor
enum FrameClock {
    static func tick() async {
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            let shot = OneShot(continuation)
            shot.link = CADisplayLink(target: shot, selector: #selector(OneShot.fire))
            shot.link?.add(to: .main, forMode: .common)
        }
    }

    private final class OneShot: NSObject {
        var link: CADisplayLink?
        private var continuation: CheckedContinuation<Void, Never>?
        init(_ continuation: CheckedContinuation<Void, Never>) { self.continuation = continuation }

        @objc func fire() {
            link?.invalidate()
            link = nil
            continuation?.resume()
            continuation = nil
        }
    }
}
