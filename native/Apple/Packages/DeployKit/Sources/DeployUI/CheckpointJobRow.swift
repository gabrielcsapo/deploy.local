import SwiftUI
import DeployCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif
func copyActivityText(_ text: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    #else
    UIPasteboard.general.string = text
    #endif
}
struct JobStatusGlyph: View {
    let job: WorkspaceJob
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Image(systemName: job.status == "succeeded" ? "checkmark.circle" : job.isFailed ? "xmark.circle" : job.status == "running" ? "circle.lefthalf.filled" : job.status == "queued" ? "clock" : "nosign")
            .foregroundStyle(job.status == "succeeded" ? WorkspaceStyle.success(scheme) : job.isFailed ? WorkspaceStyle.danger(scheme) : job.isActive ? WorkspaceStyle.statusActive(scheme) : WorkspaceStyle.secondaryText(scheme))
            .accessibilityLabel(job.statusLabel)
    }
}
struct CheckpointJobRow: View {
    let job: WorkspaceJob
    var computerName: String? = nil
    var cancel: (() -> Void)? = nil
    var showConversation: ((String) -> Void)? = nil
    var turnNumber: Int? = nil
    var earlier: [WorkspaceJob] = []
    var runNumbers: [String: Int] = [:]
    @State private var expanded = false
    @State private var wrap = true
    @Environment(\.colorScheme) private var scheme
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var sizeClass
    private var compact: Bool { sizeClass == .compact }
    #else
    private var compact: Bool { false }
    #endif
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            DisclosureGroup(isExpanded: $expanded) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack { Text("Command"); Spacer(); Button("Copy command") { copyActivityText(job.command) }.buttonStyle(.workspaceLink) }
                    Text(job.command).font(.system(.caption, design: .monospaced)).textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(12).background(WorkspaceStyle.raised(scheme))
                    HStack { Text("Output"); Spacer(); Button("Copy output") { copyActivityText(job.output) }.buttonStyle(.workspaceLink); if !compact { Button("Wrap") { wrap.toggle() }.buttonStyle(.workspaceLink).accessibilityValue(wrap ? "On" : "Off") } }
                    ScrollView((wrap || compact) ? .vertical : [.horizontal, .vertical]) {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(job.output.components(separatedBy: .newlines).enumerated()), id: \.offset) { _, line in
                                Text(line.isEmpty ? " " : line).foregroundStyle(line.range(of: "error|fatal|fail|exception", options: [.regularExpression, .caseInsensitive]) != nil ? WorkspaceStyle.danger(scheme) : WorkspaceStyle.text(scheme))
                            }
                        }.font(.system(.caption, design: .monospaced)).textSelection(.enabled).fixedSize(horizontal: !(wrap || compact), vertical: true).frame(maxWidth: .infinity, alignment: .leading).padding(12)
                    }.frame(maxHeight: 280).background(WorkspaceStyle.raised(scheme))
                    if job.truncated { Text("Showing the last 64,000 characters.").foregroundStyle(.secondary) }
                    Text([job.exitCode.flatMap { $0 != 0 ? "Exit \($0)" : nil }, "checkpoint \(job.digest.prefix(7))", turnNumber.map { "Turn \($0)" }].compactMap { $0 }.joined(separator: " · ")).foregroundStyle(.secondary)
                    if let runId = job.runId, let showConversation { Button("Show in conversation") { showConversation(runId) }.buttonStyle(.workspaceLink) }
                }.font(WorkspaceStyle.metadata).padding(.vertical, 8)
            } label: {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    VStack(alignment: .leading, spacing: 4) {
                        HStack(spacing: 8) {
                            JobStatusGlyph(job: job).accessibilityHidden(true)
                            Text(job.title).font(WorkspaceStyle.navigation).lineLimit(1).truncationMode(.middle)
                            Spacer(minLength: 4)
                            HStack(spacing: 4) {
                                Text(computerName ?? job.workerId ?? "Waiting for computer")
                                Text(job.duration(now: context.date))
                                if let date = TaskActivitySummary.date(job.createdAt) { Text(date, style: .relative) }
                            }.font(WorkspaceStyle.metadata).foregroundStyle(.secondary).lineLimit(1)
                        }
                        if !job.detailLine.isEmpty { Text(job.detailLine).font(WorkspaceStyle.metadata).foregroundStyle(job.isFailed ? WorkspaceStyle.danger(scheme) : job.waitingReason != nil ? WorkspaceStyle.statusAttention(scheme) : WorkspaceStyle.secondaryText(scheme)).lineLimit(1) }
                    }.frame(minHeight: WorkspaceStyle.controlSize, alignment: .leading)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(job.title) on \(computerName ?? job.workerId ?? "Waiting for computer"), \(job.statusLabel.lowercased()), \(job.duration(now: context.date).replacingOccurrences(of: "m", with: " minutes ").replacingOccurrences(of: "s", with: " seconds"))")
                        .accessibilityHint(job.detailLine)
                }
            }
            if !earlier.isEmpty {
                let failures = earlier.filter(\.isFailed).count
                DisclosureGroup(job.status == "succeeded" && failures > 0 ? "Passed after \(failures) failure\(failures == 1 ? "" : "s")" : "\(earlier.count) earlier attempts") {
                    ForEach(earlier) { attempt in AnyView(CheckpointJobRow(job: attempt, computerName: computerName, cancel: nil, showConversation: showConversation, turnNumber: runNumbers[attempt.runId ?? ""], runNumbers: runNumbers)) }
                }.font(WorkspaceStyle.metadata).padding(.leading, 24)
            }
            if job.isActive, let cancel { Button(job.stopRequested == true ? "Cancellation requested" : "Cancel", action: cancel).buttonStyle(.workspaceLink).disabled(job.stopRequested == true).frame(minHeight: WorkspaceStyle.controlSize) }
        }.accessibilityIdentifier("checkpoint-job-\(job.id)")
    }
}
