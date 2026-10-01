#if DEBUG
import os
import QuartzCore
import UIKit

/// A scroll benchmark for the file viewer's code list, in builds with the DEBUG condition only.
/// Launch with `-fileViewerBench YES` and open a long file: once the list has rows, it scrolls
/// top to bottom at `speed` pt/s, frame by frame, then logs frame times and the cost of configuring
/// cells ("file-bench: …" on stdout and in the unified log, category file-bench).
@MainActor
final class FileCodeBench {
    static var enabled: Bool { UserDefaults.standard.bool(forKey: "fileViewerBench") }
    private static let log = Logger(subsystem: "com.markhuot.harness", category: "file-bench")

    private weak var view: UIScrollView?
    private var link: CADisplayLink?
    private var last: CFTimeInterval?
    private var frames: [Double] = []
    private let speed: CGFloat
    /// Seconds spent in cellForItemAt while the benchmark runs, and how many cells.
    var configTime: Double = 0
    var configured = 0

    init(view: UIScrollView, speed: CGFloat = 6000) {
        self.view = view
        self.speed = speed
    }

    func start() {
        let link = CADisplayLink(target: self, selector: #selector(tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    @objc private func tick(_ link: CADisplayLink) {
        guard let view else { return stop() }
        if let last { frames.append(link.timestamp - last) }
        last = link.timestamp
        let dt = frames.last ?? (1 / 120)
        let maxY = view.contentSize.height + view.adjustedContentInset.bottom - view.bounds.height
        let y = min(maxY, view.contentOffset.y + speed * dt)
        view.contentOffset.y = y
        if y >= maxY { stop() }
    }

    private func stop() {
        link?.invalidate()
        link = nil
        let sorted = frames.sorted()
        guard !sorted.isEmpty else { return }
        let ms = { (s: Double) in String(format: "%.1f", s * 1000) }
        let target = 1.0 / Double(UIScreen.main.maximumFramesPerSecond)
        let hitches = frames.filter { $0 > target * 1.5 }.count
        let p = { (q: Double) in sorted[min(sorted.count - 1, Int(Double(sorted.count) * q))] }
        let line = "file-bench: rows=\(Int(((view?.contentSize.height ?? 0) - 20) / FileCodeMetrics.row)) frames=\(frames.count) "
            + "mean=\(ms(frames.reduce(0, +) / Double(frames.count)))ms p50=\(ms(p(0.5)))ms p95=\(ms(p(0.95)))ms p99=\(ms(p(0.99)))ms max=\(ms(sorted.last!))ms "
            + "hitches(>\(ms(target * 1.5))ms)=\(hitches) cells=\(configured) cellConfig=\(String(format: "%.0f", configured > 0 ? configTime / Double(configured) * 1_000_000 : 0))µs"
        print(line)
        Self.log.notice("\(line, privacy: .public)")
    }
}
#endif
