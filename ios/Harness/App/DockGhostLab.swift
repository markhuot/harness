#if DEBUG
import HarnessKit
import SwiftUI

/// `-debugScreen dockGhost`: the dock ghost running for real, once per row with one layer taken away, over
/// a busy backdrop like the ticket sheet it sits on. A flicker can't be seen in a still, so this is for
/// watching on a device: the row where it stops names the layer that causes it.
struct DockGhostLab: View {
    @Environment(\.palette) private var c
    @State private var slow = false

    private static let variants: [(name: String, layers: DockGhostCard.Layers)] = [
        ("A · Everything (as shipped)", .all),
        ("B · No rim light", DockGhostCard.Layers.all.subtracting(.rim)),
        ("C · No glow", DockGhostCard.Layers.all.subtracting(.glow)),
        ("D · No tint wash", DockGhostCard.Layers.all.subtracting(.tint)),
        ("E · No lift", DockGhostCard.Layers.all.subtracting(.lift)),
        ("F · Flat, no glass", DockGhostCard.Layers.all.subtracting(.glass)),
        ("G · Glass + rim only", [.glass, .rim]),
        ("H · Flat + rim only", [.rim]),
    ]

    var body: some View {
        ZStack {
            backdrop
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
                                period: DockGhostCard.pulsePeriod * (slow ? 4 : 1))
                        }
                    }
                }
                .padding(.horizontal, DockMetrics.phoneSides(screen: nil))
                .padding(.vertical, 24)
            }
        }
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
        .frame(maxHeight: .infinity, alignment: .top)
        .background(c.bg)
        .ignoresSafeArea()
    }
}
#endif
