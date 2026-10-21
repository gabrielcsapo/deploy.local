import SwiftUI
import DeployCore

struct TaskActivityView: View {
    let activity: TaskActivity
    #if os(iOS)
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    var progress: [Message] = []
    var body: some View {
        #if os(iOS)
        if horizontalSizeClass == .compact { activityContent.disclosureGroupStyle(PhoneActivityDisclosureStyle()) }
        else { activityContent }
        #else
        activityContent
        #endif
    }
    @ViewBuilder private var activityContent: some View {
        if !activity.items.isEmpty || !progress.isEmpty {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 14) {
                    ForEach(progress) { message in
                        MessageContent(content: message.content).font(.caption).foregroundStyle(.secondary)
                    }
                    ForEach(activity.items) { item in
                        DisclosureGroup {
                            if !item.detail.isEmpty { output(item.detail) }
                            if !item.output.isEmpty { output(item.output) }
                        } label: {
                            HStack(spacing: 8) {
                                Label(item.title, systemImage: item.kind == "command" ? "terminal" : item.kind == "search" ? "magnifyingglass" : "doc.text")
                                #if os(iOS)
                                if horizontalSizeClass != .compact { Spacer(minLength: 8) }
                                #else
                                Spacer(minLength: 8)
                                #endif
                                if item.status != "completed" { Text(item.status.capitalized).foregroundStyle(item.status == "failed" ? .red : .secondary) }
                                else if let exit = item.exitCode { Text("Exit \(exit)").foregroundStyle(.secondary) }
                            }.font(.caption)
                        }
                    }
                }.padding(.leading, 8).padding(.top, 12)
            } label: {
                HStack(spacing: 8) {
                    Label(activity.summary, systemImage: "terminal").lineLimit(2)
                    #if os(iOS)
                    if horizontalSizeClass != .compact { Spacer(minLength: 4) }
                    #else
                    Spacer(minLength: 4)
                    #endif
                    if ["queued", "starting", "running"].contains(activity.status) { Text("Working").font(.caption2) }
                }
            }.font(.caption).foregroundStyle(.secondary)
        }
    }
    private func output(_ value: String) -> some View {
        ScrollView { Text(value).font(.system(.caption, design: .monospaced)).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled) }
            .frame(maxHeight: 220).padding(10).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 10))
    }
}

struct TaskSourcesView: View {
    let activity: [TaskActivity]
    var expanded = false
    @State private var isExpanded = false
    private var sources: [String] { TaskActivitySummary(jobs: [], activity: activity).sources }
    var body: some View {
        if !sources.isEmpty {
            DisclosureGroup(isExpanded: $isExpanded) {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(sources, id: \.self) { source in
                        if let url = URL(string: source), ["https", "http"].contains(url.scheme ?? "") {
                            Link(destination: url) { Label(source, systemImage: "globe").frame(minHeight: WorkspaceStyle.controlSize, alignment: .leading) }
                        } else {
                            VStack(alignment: .leading, spacing: 3) {
                                Label(source.components(separatedBy: "/").last ?? source, systemImage: "doc.text")
                                Text(source).font(.caption2).foregroundStyle(.tertiary).lineLimit(1).truncationMode(.middle).textSelection(.enabled)
                            }
                        }
                    }
                }.padding(.top, 10).font(.caption)
            } label: { Label("Sources · \(sources.count)", systemImage: "doc.text") }
                .font(.caption).foregroundStyle(.secondary)
                .onAppear { isExpanded = expanded }
        }
    }
}
