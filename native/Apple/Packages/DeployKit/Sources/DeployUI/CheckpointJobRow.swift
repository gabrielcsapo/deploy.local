import SwiftUI
import DeployCore

/// A recorded job verifies an immutable checkpoint on its execution computer.
struct CheckpointJobRow: View {
    let job: WorkspaceJob
    @State private var expanded = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var createdDate: Date? {
        guard let value = job.createdAt else { return nil }
        return (try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(value))
            ?? (try? Date.ISO8601FormatStyle().parse(value))
    }

    private var status: String {
        switch job.status {
        case "succeeded": "Passed"
        case "failed": "Failed"
        case "cancelled", "canceled": "Cancelled"
        default: job.status.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }
    private var symbol: String {
        switch job.status {
        case "succeeded": "checkmark.circle.fill"
        case "failed": "xmark.circle.fill"
        case "running": "play.circle"
        case "cancelled", "canceled": "stop.circle"
        default: "clock"
        }
    }
    private var statusColor: Color {
        switch job.status {
        case "succeeded": WorkspaceStyle.success(colorScheme)
        case "failed": WorkspaceStyle.danger(colorScheme)
        case "running", "queued": WorkspaceStyle.statusActive(colorScheme)
        default: .secondary
        }
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                #if os(iOS)
                PhoneIdentifier(title: "Job", value: job.id)
                PhoneIdentifier(title: "Checkpoint", value: job.digest)
                #else
                Text("Checkpoint \(job.digest.prefix(12))")
                    .font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(colorScheme)).textSelection(.enabled)
                #endif
                if let reason = job.waitingReason, !reason.isEmpty {
                    Text(reason).font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                }
                if !job.output.isEmpty {
                    ScrollView([.horizontal, .vertical]) {
                        Text(job.output).font(.system(.footnote, design: .monospaced))
                            .textSelection(.enabled).fixedSize(horizontal: true, vertical: true)
                            .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }.frame(height: min(260, CGFloat(job.output.components(separatedBy: "\n").count) * 16 + 24))
                        .background(Color.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
                } else if job.isActive {
                    Text("Waiting for output…").font(WorkspaceStyle.metadata).foregroundStyle(.secondary)
                }
                if job.truncated { Text("Showing the last 64,000 characters.").font(WorkspaceStyle.metadata).foregroundStyle(.secondary) }
                if let error = job.error, !error.isEmpty { Text(error).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.danger(colorScheme)).textSelection(.enabled) }
            }.padding(.top, 10)
        } label: {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: symbol).foregroundStyle(statusColor)
                    .frame(width: WorkspaceStyle.iconWidth).padding(.top, 2).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 5) {
                    Text(job.command).font(.system(.subheadline, design: .monospaced)).foregroundStyle(.primary).lineLimit(2)
                    HStack(spacing: 8) {
                        Text(status).foregroundStyle(statusColor)
                        if let createdDate { Text(createdDate, format: .dateTime.hour().minute()).foregroundStyle(WorkspaceStyle.secondaryText(colorScheme)) }
                        if let exit = job.exitCode, exit != 0 { Text("Exit \(exit)").foregroundStyle(.secondary) }
                    }.font(WorkspaceStyle.metadata)
                }.frame(maxWidth: .infinity, alignment: .leading)
            }.padding(.vertical, 5)
        }.tint(WorkspaceStyle.accent(colorScheme))
            .accessibilityIdentifier("checkpoint-job-\(job.id)")
            .animation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion), value: expanded)
    }
}
