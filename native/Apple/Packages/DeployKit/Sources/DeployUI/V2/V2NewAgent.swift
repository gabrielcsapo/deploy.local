#if os(iOS)
import SwiftUI
import DeployCore

// Keep these starting points in sync with app/routes/dashboard/v2/agents/page.client.tsx.
private struct AgentTemplate: Identifiable {
    let name: String
    let summary: String
    let job: String
    var id: String { name }
    static let all: [Self] = [
        .init(name: "Dependency watcher", summary: "Checks for updates and advisories, proposes safe ones",
              job: "Check the project's dependencies for updates and security advisories. Explain what changed and which updates are safe. Open a pull request for safe patch updates; ask before anything bigger."),
        .init(name: "Pull request reviewer", summary: "Reviews open pull requests for bugs and missing tests",
              job: "Review open pull requests in the project. Point out bugs, missing tests and risky changes, with a short summary for each. Never merge."),
        .init(name: "Check fixer", summary: "Finds why checks or releases failed and proposes a fix",
              job: "Look at the project's failing checks and recent failed releases. Find the cause and propose the smallest fix as a pull request. Ask before changing anything outside the failure."),
        .init(name: "Issue triager", summary: "Sorts new issues, finds duplicates, suggests next steps",
              job: "Review new issues, find duplicates, and propose the next step for each. Ask before changing an issue."),
        .init(name: "Release notes writer", summary: "Drafts notes for what merged since its last run",
              job: "Summarize what was merged and released since your last run as short release notes. Ask before publishing them anywhere.")
    ]
}

struct V2NewAgentSheet: View {
    @Bindable var store: V2Store
    let created: (V2Agent) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    @State private var reviewing = false
    @State private var description = ""
    @State private var name = ""
    @State private var instructions = ""
    @State private var projectId = ""
    @State private var daily = false
    @State private var runTime = Calendar.current.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: 8))!
    @State private var sourceDescription: String?
    @State private var sourceTemplate: String?
    @State private var busy = false
    @State private var error: String?
    @State private var operation: Task<Void, Never>?
    private enum Field: Hashable { case description, name, instructions }
    @FocusState private var focused: Field?

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        intro
                        if reviewing { reviewFields } else { pickOrDescribe }
                    }.padding(.vertical, 16)
                }.scrollDismissesKeyboard(.interactively)
                    .onChange(of: focused) { _, field in
                        if let field { withAnimation { proxy.scrollTo(field, anchor: .center) } }
                    }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
        .background(WorkspaceStyle.canvas(scheme))
        .foregroundStyle(WorkspaceStyle.text(scheme))
        .tint(WorkspaceStyle.action(scheme))
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .presentationCornerRadius(16)
        .interactiveDismissDisabled(busy && reviewing)
        .onDisappear { operation?.cancel() }
        .onAppear { loadEvidence() }
    }

    private var header: some View {
        HStack(spacing: 0) {
            if reviewing {
                Button { focused = nil; reviewing = false; error = nil } label: {
                    Image(systemName: "chevron.left").frame(width: 44, height: 44)
                }.accessibilityLabel("Back to step 1").disabled(busy)
            } else { Color.clear.frame(width: 44, height: 44) }
            Spacer()
            Text("New agent").font(.system(size: 17, weight: .semibold))
            Spacer()
            Button { operation?.cancel(); dismiss() } label: {
                Image(systemName: "xmark").frame(width: 44, height: 44)
            }.accessibilityLabel("Cancel new agent").disabled(busy && reviewing)
        }.font(.system(size: 22)).padding(.horizontal, 8).padding(.top, 20).padding(.bottom, 4)
    }

    private var intro: some View {
        VStack(alignment: .leading, spacing: 0) {
            meta(reviewing ? "Step 2 of 2 · Review the draft" : "Step 1 of 2 · Pick or describe")
            Text(reviewing ? "Ready to edit" : "What should this agent keep doing?")
                .font(.system(size: 22, weight: .semibold)).fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4).padding(.bottom, 6).accessibilityAddTraits(.isHeader)
            meta(reviewing ? "Change anything before you create the agent." : "An agent is a standing job. It runs in the background and asks before it acts.")
        }.padding(.horizontal, 20).padding(.bottom, 16)
    }

    private var pickOrDescribe: some View {
        VStack(alignment: .leading, spacing: 0) {
            sectionLabel("Start from a template")
            V2Group {
                ForEach(AgentTemplate.all) { template in
                    if template.id != AgentTemplate.all.first?.id { Divider().padding(.leading, 14) }
                    Button { pick(template) } label: {
                        HStack(spacing: 12) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(template.name).font(.system(size: 17))
                                meta(template.summary).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "chevron.right").font(.system(size: 17)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                        }.multilineTextAlignment(.leading).padding(.horizontal, 16).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading).contentShape(Rectangle())
                    }.buttonStyle(.plain).disabled(busy)
                }
            }.padding(.horizontal, 16)
            VStack(alignment: .leading, spacing: 12) {
                field("Describe your own") {
                    multiline("Describe your own", text: $description, focus: .description, lines: 3)
                }.id(Field.description)
                meta("Your connected model drafts the name and instructions for you to review.")
            }.padding(.horizontal, 20).padding(.top, 16).disabled(busy)
        }
    }

    private var reviewFields: some View {
        VStack(alignment: .leading, spacing: 0) {
            VStack(alignment: .leading, spacing: 12) {
                field("Name") {
                    TextField("Name", text: $name).font(.system(size: 17)).textFieldStyle(.plain)
                        .focused($focused, equals: .name).padding(.horizontal, 12).frame(minHeight: 44)
                        .background(fieldBackground).accessibilityLabel("Name")
                        .onChange(of: name) { _, value in name = String(value.prefix(80)) }
                }.id(Field.name)
                field("Instructions") {
                    multiline("Instructions", text: $instructions, focus: .instructions, lines: 4)
                }.id(Field.instructions)
                field("Project") {
                    Menu {
                        Picker("Project", selection: $projectId) {
                            Text("No project").tag("")
                            ForEach(store.snapshot.projects) { Text($0.name).tag($0.id) }
                        }
                    } label: {
                        HStack {
                            Text(store.snapshot.projects.first { $0.id == projectId }?.name ?? "No project")
                            Spacer()
                            Image(systemName: "chevron.down").font(.system(size: 12))
                        }.font(.system(size: 17)).padding(.horizontal, 12).frame(minHeight: 44).background(fieldBackground)
                    }.accessibilityLabel("Project")
                }
                field("When it runs") {
                    V2Group {
                        Button { focused = nil; daily = false } label: {
                            HStack(spacing: 8) {
                                radio(selected: !daily)
                                Text("Only when you press Run now")
                                Spacer(minLength: 0)
                            }.padding(.horizontal, 12).frame(minHeight: 56).contentShape(Rectangle())
                        }.buttonStyle(.plain).accessibilityAddTraits(!daily ? .isSelected : [])
                        Divider().padding(.leading, 12)
                        HStack(spacing: 8) {
                            Button { focused = nil; daily = true } label: {
                                HStack(spacing: 8) {
                                    radio(selected: daily)
                                    Text("Every day at")
                                    Spacer(minLength: 0)
                                }.frame(minHeight: 44).contentShape(Rectangle())
                            }.buttonStyle(.plain).accessibilityAddTraits(daily ? .isSelected : [])
                            DatePicker("Daily run time on \(coordinator)’s clock", selection: $runTime, displayedComponents: .hourAndMinute)
                                .labelsHidden().datePickerStyle(.compact).disabled(!daily)
                        }.padding(.horizontal, 12).padding(.vertical, 8)
                    }.font(.system(size: 15))
                    meta("Daily runs use \(coordinator)’s clock and ask first unless Start a task is Allowed in Approvals.")
                }
            }.padding(.horizontal, 20).disabled(busy)
            sectionLabel("What it may do without asking").padding(.top, 16)
            V2Group {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Nothing yet").font(.system(size: 17))
                    meta("Every action starts at Ask me.")
                }.frame(maxWidth: .infinity, minHeight: 56, alignment: .leading).padding(.horizontal, 14)
            }.padding(.horizontal, 16)
            meta("Manage each action in Approvals after creating.").padding(.horizontal, 32).padding(.top, 8)
        }
    }

    private var footer: some View {
        VStack(spacing: 12) {
            Divider()
            VStack(alignment: .leading, spacing: 8) {
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)).accessibilityIdentifier("new-agent-error") }
                Button { reviewing ? create() : draft() } label: {
                    HStack(spacing: 8) {
                        if busy { ProgressView().tint(WorkspaceStyle.onAction(scheme)) }
                        Text(busy ? (reviewing ? "Creating…" : "Drafting…") : (reviewing ? "Create agent" : (error == nil ? "Continue" : "Try again")))
                    }
                }.buttonStyle(V2ActionStyle(primary: true))
                    .disabled(busy || (reviewing ? name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : description.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            }.padding(.horizontal, 20).padding(.bottom, 12)
        }.background(WorkspaceStyle.canvas(scheme))
    }

    private var fieldBackground: some View {
        RoundedRectangle(cornerRadius: 8).fill(WorkspaceStyle.surface(scheme))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.edge(scheme)))
    }
    private func field<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 13, weight: .medium))
            content()
        }
    }
    private func multiline(_ label: String, text: Binding<String>, focus: Field, lines: Int) -> some View {
        TextField("", text: text, axis: .vertical).font(.system(size: 17)).lineSpacing(4)
            .lineLimit(lines...).textFieldStyle(.plain).focused($focused, equals: focus)
            .padding(12).frame(minHeight: 112, alignment: .topLeading).background(fieldBackground)
            .accessibilityLabel(label)
            .onChange(of: text.wrappedValue) { _, value in text.wrappedValue = String(value.prefix(12000)) }
    }
    private func meta(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).lineSpacing(2).foregroundStyle(WorkspaceStyle.tertiary(scheme)).fixedSize(horizontal: false, vertical: true)
    }
    private func sectionLabel(_ text: String) -> some View { meta(text).padding(.horizontal, 32).padding(.bottom, 8) }
    private func radio(selected: Bool) -> some View {
        Image(systemName: selected ? "largecircle.fill.circle" : "circle").font(.system(size: 20)).accessibilityHidden(true)
    }
    private var coordinator: String { store.snapshot.live?.computers.first { $0.roles.contains(.coordinator) }?.name ?? "your coordinator" }

    private func pick(_ template: AgentTemplate) {
        if sourceTemplate != template.id {
            name = template.name; instructions = template.job; projectId = ""; daily = true
            resetTime(); sourceTemplate = template.id; sourceDescription = nil
        }
        focused = nil; error = nil; reviewing = true
    }
    private func resetTime() {
        runTime = Calendar.current.date(from: DateComponents(year: 2001, month: 1, day: 1, hour: 8))!
    }
    private func draft() {
        guard !busy else { return }
        focused = nil; error = nil
        if sourceDescription == description { reviewing = true; return }
        let job = description
        busy = true
        operation = Task {
            defer { busy = false }
            do {
                let draft = try await store.client.draftAgent(job: job)
                guard !Task.isCancelled else { return }
                name = draft.name; instructions = draft.job; projectId = ""; daily = false; resetTime()
                sourceDescription = job; sourceTemplate = nil; reviewing = true
            } catch {
                if !Task.isCancelled { self.error = coordinatorErrorDescription(error) }
            }
        }
    }
    private func create() {
        guard !busy else { return }
        focused = nil; busy = true; error = nil
        let components = Calendar.current.dateComponents([.hour, .minute], from: runTime)
        let time = String(format: "%02d:%02d", components.hour ?? 8, components.minute ?? 0)
        let values = V2NewAgent(name: name, job: instructions, projectId: projectId.isEmpty ? nil : projectId,
                                schedule: .init(enabled: daily, time: time))
        operation = Task {
            defer { busy = false }
            do { created(try await store.createAgent(values)) }
            catch { self.error = coordinatorErrorDescription(error) }
        }
    }
    private func loadEvidence() {
        guard V2Evidence.board == "NewAgentPhone" || V2Evidence.board == "NewAgentDraftPhone" else { return }
        description = "Draft release notes for home-gym from what merged since the last run."
        if V2Evidence.board == "NewAgentDraftPhone" {
            name = "Release notes writer"
            instructions = description + "\nGroup changes by feature and fix.\nAsk me before publishing."
            projectId = store.snapshot.projects.first { $0.name == "home-gym" }?.id ?? ""
            sourceDescription = description; reviewing = true
        }
    }
}
#endif
