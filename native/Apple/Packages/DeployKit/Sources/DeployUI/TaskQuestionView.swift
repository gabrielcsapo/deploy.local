import SwiftUI
import DeployCore

struct TaskQuestionView: View {
    let question: WorkspaceQuestion
    @Bindable var store: WorkspaceStore
    @State private var answer: String
    @Environment(\.colorScheme) private var colorScheme

    init(question: WorkspaceQuestion, store: WorkspaceStore) {
        self.question = question
        self.store = store
        _answer = State(initialValue: UserDefaults.standard.string(forKey: "deploy.question." + question.id) ?? "")
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Label("Waiting for your answer", systemImage: "questionmark.bubble")
                    .font(.caption).foregroundStyle(.secondary)
                Text(question.question).font(WorkspaceStyle.body).fixedSize(horizontal: false, vertical: true)
                ForEach(question.options, id: \.self) { option in
                    Button { answer = option } label: {
                        HStack {
                            Text(option).multilineTextAlignment(.leading)
                            Spacer()
                            if answer == option { Image(systemName: "checkmark").foregroundStyle(WorkspaceStyle.accent(colorScheme)) }
                        }.frame(maxWidth: .infinity, minHeight: 28, alignment: .leading)
                    }.buttonStyle(.bordered)
                        .accessibilityAddTraits(answer == option ? .isSelected : [])
                }
                TextField("Your answer…", text: $answer, axis: .vertical)
                    .lineLimit(1...3).textFieldStyle(.roundedBorder).accessibilityLabel(question.question)
                HStack {
                    Spacer()
                    Button("Skip") { Task { await store.answerQuestion(question, answer: "", dismiss: true) } }
                        .buttonStyle(.bordered)
                    Button("Continue") { Task { await store.answerQuestion(question, answer: answer) } }
                        .buttonStyle(.borderedProminent).tint(WorkspaceStyle.action(colorScheme))
                        .keyboardShortcut(.return, modifiers: .command)
                        .disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || answer.count > 4000)
                }
            }.padding(16)
        }.frame(height: question.options.isEmpty ? 190 : 260)
            .modifier(WorkspaceSurface(radius: 18))
            .disabled(!store.isConnected || store.busy)
            .onChange(of: answer) { _, value in UserDefaults.standard.set(value, forKey: "deploy.question." + question.id) }
    }
}
