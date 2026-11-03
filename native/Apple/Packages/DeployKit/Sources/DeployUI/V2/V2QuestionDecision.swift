#if os(iOS)
import SwiftUI
import DeployCore

struct V2QuestionDecision: View {
    let item: InboxItem
    @Bindable var store: V2Store
    @Binding var note: String
    let choose: (InboxAction) -> Void
    @State private var contentHeight: CGFloat = 0
    @State private var taskOpen = false
    @Environment(\.colorScheme) private var scheme

    private var answer: InboxAction? { item.actions.first { $0.id == "answer" } }
    private var dismiss: InboxAction? { item.actions.first { $0.id == "dismiss" } }
    private var projectName: String? { item.projectName ?? store.snapshot.projects.first { $0.id == item.projectId }?.name }
    private var disabled: Bool { !store.online || store.busy }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                AgentAvatar(glyph: (store.snapshot.agents.first { $0.id == item.from }?.identity ?? .from(id: item.from)).glyph, color: (store.snapshot.agents.first { $0.id == item.from }?.identity ?? .from(id: item.from)).color, size: 32)
                VStack(alignment: .leading, spacing: 2) {
                    Text(V2Labels.agentName(item)).font(.system(size: 17, weight: .semibold))
                    Text([projectName, V2Labels.askedTime(item.createdAt)].compactMap { $0 }.joined(separator: " · "))
                        .font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                }
            }
            Text(item.text.isEmpty ? item.title : item.text).font(.system(size: 17, weight: .medium))
                .fixedSize(horizontal: false, vertical: true)
            if item.context != nil || item.taskId != nil {
                VStack(spacing: 0) {
                    if let context = item.context {
                        ScrollView {
                            MessageContent(content: context.text)
                                .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                                .background(GeometryReader { proxy in
                                    Color.clear.preference(key: DecisionContentHeight.self, value: proxy.size.height)
                                })
                        }.frame(height: min(contentHeight > 0 ? contentHeight : 196, 196))
                            .onPreferenceChange(DecisionContentHeight.self) { contentHeight = $0 }
                    }
                    if item.taskId != nil {
                        if item.context != nil { Divider() }
                        HStack(spacing: 12) {
                            if contentHeight > 197 { Text("Scroll to read more").foregroundStyle(WorkspaceStyle.tertiary(scheme)) }
                            Spacer(minLength: 0)
                            Button("Open the task") { taskOpen = true }.foregroundStyle(WorkspaceStyle.accent(scheme))
                                .frame(minHeight: 44)
                        }.font(.system(size: 13)).padding(.horizontal, 12)
                    }
                }.background(WorkspaceStyle.canvas(scheme), in: RoundedRectangle(cornerRadius: 12))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
            }
            VStack(spacing: 6) {
                ForEach(V2Labels.questionOptions(item), id: \.id) { action in
                    Button(action.label) { choose(action) }.buttonStyle(V2ActionStyle(primary: action.primary == true)).disabled(disabled)
                }
            }
            if answer != nil {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Your answer").font(.system(size: 13))
                    TextField("", text: $note, axis: .vertical).font(.system(size: 17)).lineLimit(1...3)
                        .padding(.horizontal, 12).frame(minHeight: 44)
                        .background(WorkspaceStyle.canvas(scheme), in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.edge(scheme)))
                        .accessibilityLabel("Your answer").disabled(disabled)
                        .onChange(of: note) { _, value in if value.count > 4000 { note = String(value.prefix(4000)) } }
                }
            }
            HStack {
                if let dismiss { Button(dismiss.label) { choose(dismiss) }.frame(minWidth: 88, minHeight: 44).disabled(disabled) }
                Spacer()
                if let answer {
                    Button(answer.label) { choose(answer) }.buttonStyle(V2ActionStyle()).frame(width: 88)
                        .disabled(disabled || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }.sheet(isPresented: $taskOpen) {
            if let taskId = item.taskId { V2ConversationView(store: store, taskId: taskId) }
        }
    }
}

private struct DecisionContentHeight: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
#endif
