import HarnessKit
import SwiftUI

/// A tool-permission request (screens/Approval.tsx): allow once, always allow the tool on this
/// ticket, or deny with an optional note for the agent.
struct TicketDetailApprovalCard: View {
    let ticket: Ticket
    let approval: PendingApproval

    @Environment(BoardStore.self) private var store
    @Environment(Actions.self) private var actions
    @Environment(\.palette) private var c
    @State private var denying = false
    @State private var message = ""
    @State private var busy: ApprovalDecision?
    @State private var showRest = false
    @FocusState private var messageFocused: Bool

    var body: some View {
        let tool = Format.shortToolName(approval.toolName)
        let input = Format.describeApprovalInput(approval.toolName, input: approval.input)
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 10) {
                Icon("lock", size: 15, weight: .semibold)
                    .foregroundStyle(c.amber)
                    .frame(width: 30, height: 30)
                    .background(c.bgElev, in: .circle)
                VStack(alignment: .leading, spacing: 2) {
                    Text("The agent wants to use \(Text(tool).font(.mono(15.5, weight: .semibold)))")
                        .font(.system(size: 15.5, weight: .semibold))
                        .foregroundStyle(c.text)
                    NowReader(interval: .approval) { now in
                        Text("\(TicketDetailLogic.approvalSubtitle(approval, description: input.description)) · requested \(Format.relativeTime(approval.requestedAt, now: now))")
                            .font(.system(size: 13))
                            .foregroundStyle(c.text2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let reason = approval.reason {
                HStack(alignment: .top, spacing: 7) {
                    Icon("shield", size: 13).foregroundStyle(c.text2).padding(.top, 2)
                    Text("\(Text("\(TicketDetailLogic.approvalReasonSource(approval.source)):").fontWeight(.semibold)) \(reason)")
                        .font(.system(size: 13))
                        .foregroundStyle(c.text2)
                        .lineSpacing(3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            if let primary = input.primary {
                VStack(alignment: .leading, spacing: 4) {
                    Text(primary.label.uppercased()).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(c.text3)
                    ScrollView(primary.code ? [.horizontal, .vertical] : .vertical) {
                        Text(primary.value)
                            .font(primary.code ? .mono(13) : .system(size: 13))
                            .foregroundStyle(c.text)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: primary.code, vertical: true)
                            .frame(maxWidth: primary.code ? nil : .infinity, alignment: .leading)
                            .padding(9)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                    .frame(maxHeight: 160)
                    .fixedSize(horizontal: false, vertical: true)
                    .background(c.bgElev, in: .rect(cornerRadius: 8))
                }
            }
            if let rest = input.rest {
                VStack(alignment: .leading, spacing: 6) {
                    Button(TicketDetailLogic.approvalRestToggle(showing: showRest, hasPrimary: input.primary != nil)) { showRest.toggle() }
                        .font(.system(size: 13))
                        .foregroundStyle(c.accentText)
                        .buttonStyle(.plain)
                    if showRest {
                        Text(TicketDetailLogic.approvalRestJSON(rest))
                            .font(.mono(12))
                            .foregroundStyle(c.text2)
                            .textSelection(.enabled)
                    }
                }
            }
            if denying {
                TextField("", text: $message, prompt: Text("Optional: tell the agent why, or what to do instead").foregroundStyle(c.text3), axis: .vertical)
                    .font(.system(size: 15))
                    .foregroundStyle(c.text)
                    .lineLimit(3...8)
                    .focused($messageFocused)
                    .padding(10)
                    .background(c.bgElev, in: .rect(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(c.border))
                    .onAppear { messageFocused = true }
                HStack(spacing: 8) {
                    HButton("Back", variant: .ghost, fullWidth: false) { denying = false }.disabled(busy != nil)
                    Spacer()
                    HButton("Deny", icon: "x", variant: .dangerSolid, loading: busy == .deny, fullWidth: false, haptic: nil) { answer(.deny, tool: tool) }
                }
            } else {
                VStack(spacing: 8) {
                    HStack(spacing: 8) {
                        HButton("Allow once", icon: "check", variant: .primary, loading: busy == .allowOnce, haptic: nil) { answer(.allowOnce, tool: tool) }
                            .disabled(busy != nil && busy != .allowOnce)
                        HButton("Deny…", fullWidth: false) { denying = true }.disabled(busy != nil)
                    }
                    if approval.onceOnly != true {
                        HButton("Always allow \(tool) on this ticket", icon: "checkCircle", loading: busy == .allowTool, haptic: nil) { answer(.allowTool, tool: tool) }
                            .disabled(busy != nil && busy != .allowTool)
                    }
                }
            }
        }
        .padding(12)
        .background(c.amberSoft, in: .rect(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(c.amber, lineWidth: 1))
    }

    private func answer(_ decision: ApprovalDecision, tool: String) {
        guard let api = store.client as? HarnessClient else { return }
        let key = ticket.key
        let text = TicketDetailLogic.trim(message)
        let body = ApprovalBody(decision: decision, message: text.isEmpty ? nil : text)
        busy = decision
        Task {
            let ok = await actions.run(Format.approvalToast(decision, tool: tool, ticketKey: Keys.keyLabel(ticket))) {
                try await api.answerApproval(key, body)
            }
            if ok != nil { haptic(decision == .deny ? .warning : .success) }
            busy = nil
        }
    }
}
