#if DEBUG
import HarnessKit
import SwiftUI

/// `-debugScreen dockGhost`: the dock ghost running for real, once per row with its layers or rim light
/// drawn differently, over a busy backdrop like the ticket sheet it sits on. A flicker can't be seen in a
/// still, so this is for watching on a device: the row where it stops names the cause.
struct DockGhostLab: View {
    @Environment(\.palette) private var c
    @State private var slow = false

    /// Taking layers away showed only the rim light flickers, so these rows draw the rim four ways:
    /// alone on a flat card (1–4), then on the whole card (5–8).
    private static let variants: [(name: String, layers: DockGhostCard.Layers, rim: DockGhostCard.RimStyle)] = [
        ("1 · Angular gradient (as shipped), rim only", [.rim], .angular),
        ("2 · Angular, Metal raster, rim only", [.rim], .angularRaster),
        ("3 · Rotated bitmap, rim only", [.rim], .rotated),
        ("4 · Traveling radial, rim only", [.rim], .traveling),
        ("5 · Angular gradient (as shipped), whole card", .all, .angular),
        ("6 · Angular, Metal raster, whole card", .all, .angularRaster),
        ("7 · Rotated bitmap, whole card", .all, .rotated),
        ("8 · Traveling radial, whole card", .all, .traveling),
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
                                period: DockGhostCard.pulsePeriod * (slow ? 4 : 1), rimStyle: variant.rim)
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
