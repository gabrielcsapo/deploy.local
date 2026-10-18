import SwiftUI
import DeployCore

struct AgentControls: View {
    @Bindable var store: WorkspaceStore
    var workerId: String
    var disabled = false
    @State private var customModel = false
    @State private var showingOptions = false
    @State private var showingModels = false
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var worker: Worker? { store.state?.workers.first { $0.id == workerId } }
    private func providerAvailable(_ provider: String) -> Bool { worker?.isProviderAvailable(provider) ?? false }
    private var options: AgentOption? {
        store.state?.workers.first { $0.id == workerId }?.modelOptions?.first { $0.id == store.adapter }
    }
    private var models: [ModelOption] { options?.models ?? [] }
    private var efforts: [String] { models.first { $0.id == store.model }?.efforts ?? options?.efforts ?? [] }
    private var levels: [String] { [""] + efforts }
    private var popoverArrow: Edge {
        #if os(iOS)
        .bottom
        #else
        .top
        #endif
    }
    private var modelName: String { models.first { $0.id == store.model }?.name ?? (store.model.isEmpty ? providerName(store.adapter) + " default" : store.model) }
    private var effortName: String { store.effort.isEmpty ? "Default" : store.effort.capitalized }

    var body: some View {
        HStack(spacing: 8) {
            Button {
                showingModels = efforts.isEmpty
                showingOptions = true
            } label: {
                HStack(spacing: 5) {
                    Text(modelName).lineLimit(1).truncationMode(.middle)
                    if !efforts.isEmpty && !store.effort.isEmpty { Text(effortName).foregroundStyle(.secondary).fixedSize() }
                    Image(systemName: "chevron.down").font(.system(.caption, weight: .medium)).foregroundStyle(.secondary)
                }.font(WorkspaceStyle.navigation).padding(.horizontal, 10).frame(minHeight: WorkspaceStyle.controlSize)
                    .background(Color.primary.opacity(showingOptions ? 0.07 : 0.025), in: Capsule())
                    .contentShape(Capsule())
                    .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: showingOptions)
            }.buttonStyle(.plain)
                .accessibilityLabel("Model and effort: \(modelName)\(efforts.isEmpty ? "" : ", \(effortName)")")
                .popover(isPresented: $showingOptions, arrowEdge: popoverArrow) {
                    optionsPanel
                        #if os(iOS)
                        .presentationCompactAdaptation(.popover)
                        #endif
                }
        }.disabled(disabled)
            .tint(WorkspaceStyle.accent(colorScheme))
            .sheet(isPresented: $customModel) {
                VStack(alignment: .leading, spacing: 20) {
                    HStack {
                        Text("Custom model").font(.title2.weight(.semibold))
                        Spacer()
                        Button("Done") { customModel = false }.keyboardShortcut(.defaultAction)
                    }
                    Text("Enter a model ID supported by this computer’s agent.").foregroundStyle(.secondary)
                    TextField("Model ID", text: $store.model).textFieldStyle(.roundedBorder).accessibilityLabel("Custom model ID")
                        .autocorrectionDisabled()
                }.padding(28).frame(idealWidth: 420).workspaceSheet()
            }
            .onChange(of: workerId) { _, _ in store.model = ""; store.effort = ""; showingOptions = false }
            .onChange(of: disabled) { _, value in if value { showingOptions = false } }
    }
    private func providerName(_ id: String) -> String { id == "codex" ? "Codex" : id == "claude" ? "Claude" : "Local / API" }
    private var optionsPanel: some View {
        VStack(spacing: 14) {
            if showingModels {
                HStack(spacing: 10) {
                    if !efforts.isEmpty {
                        Button { showingModels = false } label: { Image(systemName: "chevron.left").frame(width: 28, height: 28).contentShape(Rectangle()) }
                            .accessibilityLabel("Back to effort")
                    }
                    Text("Select model").foregroundStyle(.secondary)
                    Spacer()
                }.padding(.horizontal, 8)
                ScrollView {
                    VStack(spacing: 2) {
                        ForEach(store.state?.adapters ?? []) { provider in
                            VStack(alignment: .leading, spacing: 2) {
                                HStack { Text(providerName(provider.id)); Spacer(); if !providerAvailable(provider.id) { Text("Unavailable") } }
                                    .font(.caption).foregroundStyle(.secondary).padding(.horizontal, 10).padding(.top, 10)
                                modelRow(provider: provider.id, id: "", name: "Default").disabled(!providerAvailable(provider.id))
                                ForEach(store.state?.workers.first { $0.id == workerId }?.modelOptions?.first { $0.id == provider.id }?.models ?? []) { model in
                                    modelRow(provider: provider.id, id: model.id, name: model.name).disabled(!providerAvailable(provider.id))
                                }
                            }
                        }
                        Button {
                            showingOptions = false
                            store.effort = ""
                            customModel = true
                        } label: { Text("Custom model for \(providerName(store.adapter))…").frame(maxWidth: .infinity, alignment: .leading).padding(10) }
                            .disabled(!providerAvailable(store.adapter))
                    }
                }.frame(maxHeight: 330)
            } else {
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "bolt").font(.system(.body)).foregroundStyle(.secondary).frame(width: 28, height: 26)
                    VStack(spacing: 3) {
                        Text(effortName).font(.system(.title3, weight: .medium)).foregroundStyle(WorkspaceStyle.accent(colorScheme))
                        Button { showingModels = true } label: {
                            HStack(spacing: 5) { Text(modelName).lineLimit(2); Image(systemName: "chevron.right").font(.caption) }
                                .foregroundStyle(.secondary)
                        }.accessibilityLabel("Select model: \(modelName)")
                    }.frame(maxWidth: .infinity)
                    Button { store.effort = "" } label: { Image(systemName: "arrow.counterclockwise").font(.system(.body)).foregroundStyle(.secondary).frame(width: 28, height: 26) }
                        .accessibilityLabel("Reset effort to default")
                }
                VStack(spacing: 6) {
                    Slider(value: Binding(get: { Double(levels.firstIndex(of: store.effort) ?? 0) }, set: { store.effort = levels[min(levels.count - 1, max(0, Int($0.rounded())))] }), in: 0...Double(max(1, levels.count - 1)), step: 1)
                        .tint(WorkspaceStyle.accent(colorScheme)).accessibilityLabel("Reasoning effort").accessibilityValue(effortName)
                    HStack { Text("Default"); Spacer(); Text(efforts.last?.capitalized ?? "") }.font(.caption2).foregroundStyle(.secondary)
                }
            }
        }.buttonStyle(.plain).font(WorkspaceStyle.navigation).padding(18).frame(width: 320)
            .animation(WorkspaceStyle.Motion.standard(reduceMotion: reduceMotion), value: showingModels)
    }
    private func modelRow(provider: String, id: String, name: String, subtitle: String? = nil) -> some View {
        Button {
            store.adapter = provider; store.model = id; store.effort = ""; showingOptions = false
        } label: {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(name)
                    if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                if (store.adapter == provider && store.model == id) { Image(systemName: "checkmark").foregroundStyle(WorkspaceStyle.accent(colorScheme)) }
            }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                .background(((store.adapter == provider && store.model == id) ? WorkspaceStyle.selected(colorScheme) : Color.clear), in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }.accessibilityLabel("\(providerName(provider)): \(name)")
            .accessibilityAddTraits((store.adapter == provider && store.model == id) ? .isSelected : [])
    }
}
