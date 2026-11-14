#if os(iOS)
import SwiftUI
import DeployCore

/// Search on iPhone: the same names, code and messages the web search box finds.
/// Board: design/boards/SearchPhone.html.
struct V2SearchView: View {
    @Bindable var store: V2Store
    var initialText = ""
    let openTask: (String) -> Void
    let openAgent: (String) -> Void
    @State private var text = ""
    @State private var results: V2SearchResults?
    @State private var code: V2SearchCode?
    @State private var all: Listing?
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @Environment(\.openURL) private var openURL
    enum Listing: String, Identifiable { case code, messages; var id: String { rawValue } }

    private var query: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var searchesText: Bool { query.count >= V2SearchText.textMinimum }
    private var current: V2SearchResults? { results?.query == query ? results : nil }
    private var currentCode: V2SearchCode? { code?.query == query ? code : nil }
    private var searchingCode: Bool { searchesText && currentCode == nil }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    HStack(spacing: 8) {
                        Image(systemName: "magnifyingglass").foregroundStyle(WorkspaceStyle.tertiary(scheme))
                        TextField("Search", text: $text).font(.system(size: 17)).focused($focused)
                            .textInputAutocapitalization(.never).autocorrectionDisabled().submitLabel(.search)
                    }.padding(.horizontal, 12).frame(height: 44)
                        .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
                    Button("Cancel") { dismiss() }.font(.system(size: 17)).foregroundStyle(WorkspaceStyle.accent(scheme))
                        .frame(minHeight: 44).padding(.horizontal, 8)
                }.padding(.leading, 16).padding(.trailing, 8).padding(.vertical, 4)
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) { groups }.padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 24)
                }.scrollIndicators(.hidden).scrollDismissesKeyboard(.immediately)
            }.background(WorkspaceStyle.canvas(scheme)).foregroundStyle(WorkspaceStyle.text(scheme))
                .toolbar(.hidden, for: .navigationBar)
                .navigationDestination(item: $all) { V2SearchAll(store: store, listing: $0, query: query, messages: current?.messages.items ?? [], open: open, openCode: openCode) }
        }.task { if text.isEmpty { text = initialText }; focused = initialText.isEmpty }
            .task(id: query) { await search() }
    }

    @ViewBuilder private var groups: some View {
        if let current {
            let agents = current.names.filter { $0.kind == "agent" }
            if !current.tasks.isEmpty {
                group("Tasks") {
                    rows(current.tasks) { task in
                        Button { open(task: task.id) } label: {
                            V2SearchRow(title: task.title, subtitle: [task.agent, task.at.map(V2Evidence.shortDate)].compactMap { $0 }.joined(separator: " · "), query: query)
                        }
                    }
                }
            }
            if !agents.isEmpty {
                group("Agents") {
                    rows(agents) { agent in
                        Button { open(agent: agent.id) } label: {
                            V2SearchRow(title: agent.title, subtitle: "", query: query, identity: identity(agent.id))
                        }
                    }
                }
            }
        }
        if searchingCode { header("Code", "Searching…") }
        else if let currentCode, currentCode.lines > 0 {
            group("Code", currentCode.count) {
                rows(Array(currentCode.items.prefix(2))) { line in
                    Button { openCode(line) } label: { V2SearchCodeRow(line: line, query: query) }
                }
                if currentCode.lines > min(2, currentCode.items.count) {
                    Divider().padding(.leading, 16)
                    Button { all = .code } label: {
                        V2SettingsRow(title: "Show all \(currentCode.lines)\(currentCode.truncated ? "+" : "") in code", icon: nil) { V2SettingsChevron() }
                    }
                }
            }
        }
        if let current, current.messages.total > 0 {
            group("Messages", String(current.messages.total)) {
                rows(Array(current.messages.items.prefix(2))) { message in
                    Button { open(message) } label: { V2SearchMessageRow(message: message, query: query, identity: identity(message.agentId)) }
                }
                if current.messages.total > 2 {
                    Divider().padding(.leading, 16)
                    Button { all = .messages } label: {
                        V2SettingsRow(title: "Show all \(current.messages.total) in messages", icon: nil) { V2SettingsChevron() }
                    }
                }
            }
        }
        if let current, !searchingCode, current.tasks.isEmpty, current.messages.total == 0, (currentCode?.lines ?? 0) == 0,
           !current.names.contains(where: { $0.kind == "agent" }) {
            V2Empty(title: "Nothing matches “\(query)”", message: "Looked in names, in code on each project’s main branch, and in messages.")
                .padding(.horizontal, 16)
        }
    }

    private func header(_ title: String, _ trailing: String? = nil) -> some View {
        HStack {
            Text(title)
            Spacer()
            if let trailing { Text(trailing) }
        }.font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 16).accessibilityAddTraits(.isHeader)
    }
    private func group<Content: View>(_ title: String, _ trailing: String? = nil, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            header(title, trailing)
            V2Group { content() }
        }
    }
    @ViewBuilder private func rows<Item: Identifiable, Row: View>(_ items: [Item], @ViewBuilder row: @escaping (Item) -> Row) -> some View {
        ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
            if index > 0 { Divider().padding(.leading, 16) }
            row(item)
        }
    }
    private func identity(_ agent: String?) -> V2AgentAvatar? {
        guard let agent else { return nil }
        return store.snapshot.agents.first { $0.id == agent }?.identity ?? .from(id: agent)
    }
    private func open(task id: String) { dismiss(); openTask(id) }
    private func open(agent id: String) { dismiss(); openAgent(id) }
    private func open(_ message: V2SearchMessage) {
        if let task = message.taskId { open(task: task) } else if let agent = message.agentId { open(agent: agent) }
    }
    /// iPhone has no file viewer; a code result opens the file at its line on the web.
    private func openCode(_ line: V2SearchCode.Line) {
        guard let base = try? store.client.connection.baseURL(),
              let url = URL(string: V2SearchText.codePath(line, query: query), relativeTo: base) else { return }
        openURL(url)
    }
    private func search() async {
        let query = query
        guard !query.isEmpty else { results = nil; code = nil; return }
        // Wait for a pause in typing; a newer search cancels this one.
        try? await Task.sleep(for: .milliseconds(250))
        guard !Task.isCancelled else { return }
        if let found = try? await store.client.search(query), !Task.isCancelled { results = found }
        guard query.count >= V2SearchText.textMinimum, !Task.isCancelled else { return }
        let lines = (try? await store.client.searchCode(query)) ?? V2SearchCode.none(query)
        if !Task.isCancelled { code = lines }
    }
}

/// Every match of one kind, pushed from "Show all".
private struct V2SearchAll: View {
    @Bindable var store: V2Store
    let listing: V2SearchView.Listing
    let query: String
    let messages: [V2SearchMessage]
    let open: (V2SearchMessage) -> Void
    let openCode: (V2SearchCode.Line) -> Void
    @State private var code: V2SearchCode?
    @State private var failed = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                if listing == .messages {
                    V2Group {
                        ForEach(Array(messages.enumerated()), id: \.element.id) { index, message in
                            if index > 0 { Divider().padding(.leading, 16) }
                            Button { open(message) } label: {
                                V2SearchMessageRow(message: message, query: query, identity: message.agentId.map { id in store.snapshot.agents.first { $0.id == id }?.identity ?? .from(id: id) })
                            }
                        }
                    }
                } else if let code {
                    Text(code.count).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).padding(.horizontal, 16)
                    V2Group {
                        ForEach(Array(code.items.enumerated()), id: \.element.id) { index, line in
                            if index > 0 { Divider().padding(.leading, 16) }
                            Button { openCode(line) } label: { V2SearchCodeRow(line: line, query: query) }
                        }
                    }
                } else if failed {
                    V2Empty(title: "Code search is unavailable", message: "Pull down to try again.").padding(.horizontal, 16)
                } else { V2Group { V2SkeletonRows(count: 3) } }
            }.padding(.horizontal, 16).padding(.vertical, 12)
        }.background(WorkspaceStyle.canvas(scheme)).scrollIndicators(.hidden)
            .navigationTitle(listing == .code ? "Code" : "Messages").navigationBarTitleDisplayMode(.inline)
            .task { await load() }.refreshable { await load() }
    }
    private func load() async {
        guard listing == .code else { return }
        do { code = try await store.client.searchCode(query, limit: 200); failed = false } catch { failed = code == nil }
    }
}

/// `text` with every match of `query` marked, as the web search box marks it.
private func marked(_ text: String, _ query: String, _ scheme: ColorScheme) -> AttributedString {
    var result = AttributedString()
    for (index, part) in V2SearchText.parts(text, matching: query).enumerated() {
        var piece = AttributedString(part)
        if index % 2 == 1 { piece.backgroundColor = WorkspaceStyle.warning(scheme).opacity(0.32) }
        result += piece
    }
    return result
}

private struct V2SearchRow: View {
    let title: String
    let subtitle: String
    let query: String
    var identity: V2AgentAvatar? = nil
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 12) {
            if let identity { AgentAvatar(glyph: identity.glyph, color: identity.color, size: 30) }
            VStack(alignment: .leading, spacing: 2) {
                Text(marked(title, query, scheme)).font(.system(size: 17)).foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(2)
                if !subtitle.isEmpty { Text(subtitle).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).lineLimit(1) }
            }.multilineTextAlignment(.leading)
            Spacer(minLength: 4)
        }.padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: subtitle.isEmpty ? 52 : 64).contentShape(Rectangle())
    }
}
private struct V2SearchCodeRow: View {
    let line: V2SearchCode.Line
    let query: String
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("\(line.path):\(String(line.line))").font(.system(size: 13, design: .monospaced)).foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(1).truncationMode(.head)
            Text(marked(line.text, query, scheme)).font(.system(size: 13, design: .monospaced)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).lineLimit(1)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 64).contentShape(Rectangle())
            .accessibilityElement(children: .combine).accessibilityHint("Opens the file on the web")
    }
}
private struct V2SearchMessageRow: View {
    let message: V2SearchMessage
    let query: String
    let identity: V2AgentAvatar?
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 12) {
            if let identity { AgentAvatar(glyph: identity.glyph, color: identity.color, size: 30) }
            VStack(alignment: .leading, spacing: 2) {
                Text(message.title).font(.system(size: 17)).foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(1)
                Text(marked(message.snippet, query, scheme)).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).lineLimit(1)
            }
            Spacer(minLength: 4)
            Text(V2Evidence.shortDate(message.at)).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme)).fixedSize()
        }.padding(.horizontal, 16).padding(.vertical, 8).frame(minHeight: 64).contentShape(Rectangle())
    }
}
#endif
