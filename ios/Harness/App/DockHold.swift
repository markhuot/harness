import HarnessKit
import SwiftUI
import UIKit

/// The hold-to-dock gesture's state, for one window: drives DockArming from a surface that reports
/// where the finger is and how far the sheet (or panel) has left rest, and tells the views when it
/// arms (the ghost dock card) and the root's dismissal binding whether a release was armed.
///
/// A still finger sends no events, so a task wakes at the moment the hold would arm and samples again.
/// Nothing here reads velocity.
@MainActor @Observable final class DockHold {
    /// The ghost dock card is showing and a release will dock.
    private(set) var armed = false

    /// The finger's progress toward the way out (a fraction of the screen along that axis) and how
    /// far the surface is from rest; nil when there's nothing to read.
    @ObservationIgnored private var sample: () -> (progress: Double, displacement: Double)? = { nil }

    @ObservationIgnored private var arming = DockArming()
    @ObservationIgnored private var timer: Task<Void, Never>?
    @ObservationIgnored private let haptic = UIImpactFeedbackGenerator(style: .medium)

    static var now: TimeInterval { ProcessInfo.processInfo.systemUptime }

    /// A touch began on a surface; `sample` reads that surface for as long as the touch lasts.
    func touchDown(sample: @escaping () -> (progress: Double, displacement: Double)?) {
        self.sample = sample
        haptic.prepare()
        arming.touchDown()
        publish()
        evaluate()
    }

    /// The finger or the surface moved, or the timer fired.
    func evaluate() {
        if let s = sample() {
            arming.update(progress: s.progress, displacement: s.displacement, now: Self.now)
        } else {
            arming.update(progress: 0, displacement: 0, now: Self.now)
        }
        publish()
        timer?.cancel()
        guard let at = arming.armsAt() else { return }
        timer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, at - Self.now) + 0.01))
            guard !Task.isCancelled else { return }
            self?.evaluate()
        }
    }

    /// The finger lifted: an armed hold latches the intent for the dismissal that follows.
    func ended() {
        arming.release(now: Self.now)
        timer?.cancel()
        publish()
    }

    func cancelled() {
        arming.cancel()
        timer?.cancel()
        publish()
    }

    /// Whether the dismissal now happening is the armed release; read and cleared once.
    func takeIntent() -> Bool { arming.takeIntent(now: Self.now) }

    private func publish() {
        guard armed != arming.armed else { return }
        armed = arming.armed
        if armed { haptic.impactOccurred() }
    }
}

/// The ghost of the docked card: the card the ticket becomes, labelled "Dock", shown while the hold
/// is armed. Never interactive. Reduce Motion fades it where it would slide.
struct DockGhostCard: View {
    let title: String
    var armed: Bool
    /// Pins the pulse at a point in its loop (0...1) instead of running it; snapshots use this.
    var pulsePhase: Double?
    /// Snapshots can't set the system's Reduce Motion, so they ask for it here.
    var forceReduceMotion = false
    @Environment(\.palette) private var c
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion

    private var reduceMotion: Bool { forceReduceMotion || systemReduceMotion }

    /// Seconds for one pulse.
    static let pulsePeriod = 4.8
    /// How far the card rises at the top of the pulse.
    static let bounce: CGFloat = 3

    /// 0 at rest, 1 at the top of the pulse, easing both ways.
    static func wave(phase: Double) -> Double {
        0.5 - 0.5 * cos(2 * .pi * phase)
    }

    var body: some View {
        TimelineView(.animation(paused: !armed || pulsePhase != nil)) { context in
            let phase = pulsePhase
                ?? context.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: Self.pulsePeriod) / Self.pulsePeriod
            card(phase: phase)
        }
        .opacity(armed ? 1 : 0)
        .offset(y: armed || reduceMotion ? 0 : DockMetrics.height)
        .animation(.snappy(duration: 0.2), value: armed)
        .allowsHitTesting(false)
        // Only there while armed; the walkthrough reads it to see the hold arm.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Dock card, \(title)")
        .accessibilityHidden(!armed)
        .accessibilityIdentifier("dock-ghost")
    }

    private func card(phase: Double) -> some View {
        let wave = Self.wave(phase: phase)
        // Reduce Motion keeps only a soft breathe of the glow: nothing travels, rises or scales.
        let lift = reduceMotion || !armed ? 0 : wave
        return HStack(spacing: 10) {
            Image(systemName: "arrow.down.to.line")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(c.accent)
            Text("Dock")
                .font(.headline)
                .foregroundStyle(c.text)
            Text(title)
                .font(.subheadline)
                .foregroundStyle(c.text2)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 22)
        .frame(height: DockMetrics.height)
        .glassEffect(.regular.tint(c.accent.opacity(0.06)), in: .capsule)
        // The breathing is opacity only: a glass tint or blur radius that changes every frame is
        // re-rendered in steps, which read as the purple stuttering around the card.
        .overlay {
            Capsule()
                .fill(c.accent.opacity(0.10 * wave))
                .allowsHitTesting(false)
        }
        // A soft accent glow behind the glass, breathing with the pulse.
        .background {
            Capsule()
                .fill(c.accent)
                .opacity(0.14 + 0.20 * wave)
                .blur(radius: 13)
                .padding(.horizontal, 6)
                .drawingGroup()
        }
        // A light that circles the rim once per pulse. The gradient is angular and fades to clear at
        // both ends, so a full turn (phase 1) draws exactly what rest (phase 0) does: no jump at the loop.
        .overlay {
            if !reduceMotion {
                Capsule()
                    .strokeBorder(
                        AngularGradient(
                            stops: [
                                .init(color: .clear, location: 0),
                                .init(color: c.accent.opacity(0.7), location: 0.5),
                                .init(color: .clear, location: 1),
                            ],
                            center: .center,
                            angle: .degrees(360 * phase)),
                        lineWidth: 1.5)
            }
        }
        .scaleEffect(1 + 0.01 * lift)
        .offset(y: -Self.bounce * lift)
    }
}

/// Watches the touches on the iPhone's ticket sheet without taking any: it never leaves `.possible`,
/// reads touches in window coordinates, and neither blocks nor is blocked by the system's pan and
/// the ticket's scroll views. (A long-press would time from touch-down, hit-testing is cancelled
/// once the system pan takes over, and a SwiftUI drag blocks scrolling.)
final class DockHoldRecognizer: UIGestureRecognizer {
    var onBegan: () -> Void = {}
    var onMoved: () -> Void = {}
    var onEnded: () -> Void = {}
    var onCancelled: () -> Void = {}
    /// Where the (first) finger is in the window.
    private(set) var location: CGPoint = .zero
    private var tracked: UITouch?

    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
    }

    override func canPrevent(_ preventedGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    override func canBePrevented(by preventingGestureRecognizer: UIGestureRecognizer) -> Bool { false }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        guard tracked == nil, let touch = touches.first else { return }
        tracked = touch
        location = touch.location(in: nil)
        onBegan()
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let tracked, touches.contains(tracked) else { return }
        location = tracked.location(in: nil)
        onMoved()
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let tracked, touches.contains(tracked) else { return }
        self.tracked = nil
        onEnded()
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        guard let tracked, touches.contains(tracked) else { return }
        self.tracked = nil
        onCancelled()
    }

    override func reset() { tracked = nil }
}

/// Installs the hold gesture on the ticket sheet's container view. The ghost dock card is not drawn
/// here: it is the dock's incoming bottom slot (DockedCardsContainer), which sits above the sheet.
struct DockHoldHost: UIViewRepresentable {
    let hold: DockHold
    /// The system's dismissal ended after an armed release with the ticket still up (the system
    /// cancelled it, an upward flick say): dock anyway, so the ghost's label is never wrong.
    let dockAnyway: () -> Void

    func makeUIView(context: Context) -> Probe { Probe(hold: hold) }

    func updateUIView(_ view: Probe, context: Context) { view.dockAnyway = dockAnyway }

    final class Probe: UIView {
        let hold: DockHold
        var dockAnyway: () -> Void = {}
        private let recognizer = DockHoldRecognizer()
        /// Where the sheet's top edge rests, the highest it has been at a touch-down.
        private var restTop: CGFloat = .infinity
        private weak var container: UIView?

        init(hold: DockHold) {
            self.hold = hold
            super.init(frame: .zero)
            isUserInteractionEnabled = false
            recognizer.onBegan = { [weak self] in self?.began() }
            recognizer.onMoved = { [weak hold] in hold?.evaluate() }
            recognizer.onEnded = { [weak self] in self?.ended() }
            recognizer.onCancelled = { [weak hold] in hold?.cancelled() }
        }

        required init?(coder: NSCoder) { fatalError() }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            recognizer.view?.removeGestureRecognizer(recognizer)
            guard window != nil, let presented = presentedController,
                  let container = presented.presentationController?.containerView else { return }
            self.container = container
            container.addGestureRecognizer(recognizer)
            restTop = .infinity
        }

        /// The view controller the sheet presents: the outermost one above this view.
        private var presentedController: UIViewController? {
            var responder: UIResponder? = self
            var found: UIViewController?
            while let r = responder {
                if let vc = r as? UIViewController {
                    found = vc
                    if vc.parent == nil { break }
                }
                responder = r.next
            }
            return found?.presentingViewController == nil ? nil : found
        }

        private var presentedView: UIView? { presentedController?.presentationController?.presentedView }

        /// Where the sheet's top edge is on screen right now, mid-drag included.
        private var top: CGFloat? {
            guard let view = presentedView else { return nil }
            return (view.layer.presentation()?.frame ?? view.frame).minY
        }

        private func reading() -> (progress: Double, displacement: Double)? {
            guard let top, let window, window.bounds.height > 0 else { return nil }
            return (progress: recognizer.location.y / window.bounds.height,
                    displacement: restTop.isFinite ? top - restTop : 0)
        }

        private func began() {
            if let top { restTop = min(restTop, top) }
            hold.touchDown { [weak self] in self?.reading() }
        }

        private func ended() {
            hold.ended()
            // The system's dismissal decides on the same lift. If it was cancelled and the armed
            // release is still latched, dock programmatically.
            let controller = presentedController
            DispatchQueue.main.async { [weak self] in
                guard let coordinator = controller?.transitionCoordinator else {
                    // No dismissal under way: nothing will take the latched release, so drop it
                    // rather than let an escape or VoiceOver dismissal inside its window dock.
                    self?.hold.cancelled()
                    return
                }
                let settle: (UIViewControllerTransitionCoordinatorContext) -> Void = { context in
                    guard context.isCancelled else { return }
                    MainActor.assumeIsolated { if self?.hold.takeIntent() == true { self?.dockAnyway() } }
                }
                if coordinator.isInteractive {
                    coordinator.notifyWhenInteractionChanges(settle)
                } else {
                    // The interaction already ended: its outcome arrives with the transition.
                    coordinator.animate(alongsideTransition: nil, completion: settle)
                }
            }
        }
    }
}
