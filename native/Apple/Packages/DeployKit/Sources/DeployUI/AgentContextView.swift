import SwiftUI
import DeployCore
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// The exact coordinator snapshot passed to this run, kept quiet until requested.
struct AgentContextView: View {
    let run: Run
    @State private var expanded = false
    var body: some View {
        if let context = run.agentContext, !context.isEmpty {
            VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: WorkspaceStyle.IconAction.gap) {
                        WorkspaceGlyph(name: expanded ? .chevronDown : .chevron, size: WorkspaceStyle.IconAction.compactGlyph)
                        Text("What the agent was told")
                    }
                }
                    .buttonStyle(.workspaceLink)
                    .accessibilityValue(expanded ? "Expanded" : "Collapsed")
                if let timestamp = TaskActivitySummary.date(run.agentContextAt) {
                    Text(timestamp, style: .relative).help(timestamp.formatted()).font(WorkspaceStyle.metadata).foregroundStyle(.secondary).textSelection(.enabled)
                }
                if expanded {
                    ScrollView {
                        Text(context).font(.system(.caption, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
                    }.frame(maxHeight: WorkspaceStyle.contentWidth)
                }
            }
        }
    }
}

struct ReplyActionsView: View {
    let message: Message
    let run: Run?
    @State private var showContext = false
    @State private var linkCopied = false
    @Environment(\.mediaConnection) private var connection
    private var link: String {
        guard let origin = connection?.origin, var url = URLComponents(string: origin) else { return "" }
        url.path = "/dashboard"; url.queryItems = [URLQueryItem(name: "task", value: message.taskId)]
        url.fragment = "message-" + message.id
        return url.url?.absoluteString ?? ""
    }
    var body: some View {
        VStack(alignment: .leading, spacing: WorkspaceStyle.space2) {
            WorkspaceActionCluster {
                WorkspaceCopyButton(label: "Copy reply", text: message.content)
                Menu {
                    if run?.agentContext?.isEmpty == false { Button("What the agent was told") { showContext = true } }
                    Button(linkCopied ? "Copied link" : "Copy link to message") {
                        #if os(macOS)
                        NSPasteboard.general.clearContents()
                        linkCopied = NSPasteboard.general.setString(link, forType: .string)
                        #else
                        UIPasteboard.general.string = link; linkCopied = true
                        #endif
                        if linkCopied { AccessibilityNotification.Announcement("Copied").post() }
                    }.disabled(link.isEmpty)
                    if let date = TaskActivitySummary.date(message.createdAt) { Text(date.formatted()) }
                } label: { WorkspaceToolbarIcon("More reply actions", icon: .more) }
                    .menuStyle(.borderlessButton).fixedSize().help(TaskActivitySummary.date(message.createdAt)?.formatted() ?? "More reply actions")
            }
            if showContext, let context = run?.agentContext {
                HStack { Text("What the agent was told").font(WorkspaceStyle.metadata); Spacer(); WorkspaceIconButton(label: "Close agent context", icon: .close) { showContext = false } }
                ScrollView { Text(context).font(.system(.caption, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading) }.frame(maxHeight: 400)
            }
        }
    }
}
