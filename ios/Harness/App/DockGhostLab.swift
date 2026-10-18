#if DEBUG
import HarnessKit
import SwiftUI

/// `-debugScreen dockGhost`: the dock ghost running for real, once per row with its layers or rim light
/// drawn differently, over a busy backdrop like the ticket sheet it sits on. A flicker can't be seen in a
/// still, so this is for watching on a device: the row where it stops names the cause.
struct DockGhostLab: View {
    @Environment(\.palette) private var c
    @State private var slow = false

    typealias Look = DockGhostCard.RimLook
    /// Only the rim light flickers, and only when drawn as an AngularGradient whose angle changes; a fixed
    /// gradient turned by a rotation is clean. These rows try how bright and wide that light should be on
    /// the whole card, where the shipped 0.7 purple barely shows.
    private static let variants: [(name: String, layers: DockGhostCard.Layers, rim: DockGhostCard.RimStyle, look: Look)] = [
        ("1 · As shipped (flickers)", .all, .angular, Look()),
        ("2 · Rotated, shipped brightness", .all, .rotated, Look()),
        ("3 · Rotated, full purple, 2pt", .all, .rotated, Look(opacity: 1, width: 2)),
        ("4 · Rotated, full purple, 2pt, short light", .all, .rotated, Look(opacity: 1, width: 2, spread: 0.35)),
        ("5 · Rotated, white core, 2pt, short light", .all, .rotated, Look(opacity: 1, width: 2, spread: 0.35, whiteCore: true)),
        ("6 · Rotated, white core, 2.5pt, half turn", .all, .rotated, Look(opacity: 1, width: 2.5, spread: 0.5, whiteCore: true)),
    ]

    var body: some View {
        ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Toggle("Slow motion (4×)", isOn: $slow)
                        .padding(.horizontal, 6)
                    ForEach(Self.variants, id: \.name) { variant in
                        VStack(alignment: .leading, spacing: 6) {
                            Text(variant.name)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(c.text)
                                .padding(.horizontal, 6)
                            DockGhostCard(
                                title: "HARNESS-7 Add the pulse", armed: true, layers: variant.layers,
                                period: DockGhostCard.pulsePeriod * (slow ? 4 : 1), rimStyle: variant.rim, rimLook: variant.look)
                        }
                    }
                }
                .padding(.horizontal, DockMetrics.phoneSides(screen: nil))
                .padding(.vertical, 24)
        }
        // A background, not a ZStack sibling: the backdrop is taller than the screen, and as a sibling it
        // sized the stack past the screen and pushed the top rows out of reach.
        .background(alignment: .top) { backdrop }
        .navigationTitle("Dock ghost lab")
        .navigationBarTitleDisplayMode(.inline)
    }

    /// Stripes of text and color, so the glass has something to refract.
    private var backdrop: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(0..<40, id: \.self) { i in
                Text("Ticket \(i): the quick brown fox jumps over the lazy dog")
                    .font(.subheadline)
                    .foregroundStyle(c.text2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 16)
                    .frame(height: 28)
                    .background(i % 3 == 0 ? c.accentSoft : c.bg)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(c.bg)
        .clipped()
        .ignoresSafeArea()
    }
}
#endif
