#if os(iOS)
import SwiftUI
import DeployCore

struct V2NewAgentSheet: View {
    @Bindable var store: V2Store
    var created: (V2Agent) -> Void
    @State private var name = V2Evidence.newAgentName ?? ""
    @State private var avatar = V2Evidence.newAgentAvatar ?? V2AgentAvatar.random()
    @State private var contentHeight: CGFloat = 540
    @State private var busy = false
    @State private var error: String?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 24) {
                V2AgentIdentity(avatar: $avatar, creating: true)
                VStack(alignment: .leading, spacing: 8) { Text("Name").font(.system(size: 13)).foregroundStyle(.secondary); TextField("Name your agent", text: $name).font(.system(size: 17)).textFieldStyle(.roundedBorder) }
                if let error { Text(error).font(.system(size: 13)).foregroundStyle(WorkspaceStyle.danger(scheme)) }
                Button("Create") { create() }.buttonStyle(V2PrimaryButtonStyle()).disabled(busy || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }.padding(20)
                .background(GeometryReader { geometry in
                    Color.clear.onAppear { contentHeight = geometry.size.height + 56 }
                        .onChange(of: geometry.size.height) { _, height in contentHeight = height + 56 }
                })
                .frame(maxHeight: .infinity, alignment: .top)
                .background(WorkspaceStyle.canvas(scheme)).navigationTitle("New agent").navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("Close").disabled(busy) } }
        }.presentationDetents([.height(contentHeight)]).presentationDragIndicator(.visible).interactiveDismissDisabled(busy)
    }
    private func create() {
        guard !busy else { return }; busy = true; error = nil
        Task { defer { busy = false }; do { created(try await store.createAgent(V2NewAgent(name: name.trimmingCharacters(in: .whitespacesAndNewlines), avatar: avatar))) } catch { self.error = coordinatorErrorDescription(error) } }
    }
}
struct V2AgentIdentity: View {
    @Binding var avatar: V2AgentAvatar
    var creating = false
    @State private var choosing = false
    var body: some View {
        VStack(spacing: 4) {
            Button { choosing = true } label: {
                VStack(spacing: 8) { AgentAvatar(glyph: avatar.glyph, color: avatar.color, size: 88); Text(creating ? "Choose avatar" : "Change avatar").font(.system(size: 13)).foregroundStyle(.secondary) }
            }.buttonStyle(.plain)
            Button("Shuffle") { avatar = .random() }.font(.system(size: 15)).frame(minHeight: 44).buttonStyle(.plain).foregroundStyle(.primary)
            V2AgentColors(avatar: $avatar).frame(maxWidth: 260)
        }.frame(maxWidth: .infinity).sheet(isPresented: $choosing) { V2AgentAvatarPicker(avatar: $avatar) }
            .task { if creating && V2Evidence.agentsBoard == .avatar { choosing = true } }
    }
}
struct V2AgentColors: View {
    @Binding var avatar: V2AgentAvatar
    private let names = ["Violet", "Blue", "Green", "Amber", "Red", "Indigo", "Teal", "Orange", "Pink", "Gray"]
    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 0), count: 5), spacing: 0) {
            ForEach(Array(V2AgentAvatar.colors.enumerated()), id: \.element) { i, color in
                Button { avatar.color = color } label: { Circle().fill(AgentAvatar.tint(color)).frame(width: 22, height: 22).padding(3).overlay(Circle().stroke(avatar.color == color ? Color.primary : .clear, lineWidth: 1)).frame(minWidth: 44, minHeight: 44) }.accessibilityLabel(names[i]).accessibilityAddTraits(avatar.color == color ? .isSelected : [])
            }
        }
    }
}
struct V2AgentAvatarPicker: View {
    @Binding var avatar: V2AgentAvatar
    @State private var draft: V2AgentAvatar
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var scheme
    init(avatar: Binding<V2AgentAvatar>) { _avatar = avatar; _draft = State(initialValue: avatar.wrappedValue) }
    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    LazyVGrid(columns: Array(repeating: GridItem(.flexible()), count: 4), spacing: 12) {
                        ForEach(V2AgentAvatar.glyphs, id: \.self) { glyph in
                            Button { draft.glyph = glyph } label: { AgentAvatar(glyph: glyph, color: draft.color, size: 64).frame(maxWidth: .infinity, minHeight: 76).overlay(RoundedRectangle(cornerRadius: 12).stroke(draft.glyph == glyph ? WorkspaceStyle.text(scheme) : WorkspaceStyle.line(scheme), lineWidth: draft.glyph == glyph ? 2 : 1)) }.accessibilityLabel(glyph).accessibilityAddTraits(draft.glyph == glyph ? .isSelected : [])
                        }
                    }
                    Text("Color").font(.system(size: 13)).foregroundStyle(.secondary)
                    V2AgentColors(avatar: $draft).frame(maxWidth: 260).frame(maxWidth: .infinity)
                }.padding(16)
            }.safeAreaInset(edge: .bottom) {
                Button("Done") { avatar = draft; dismiss() }.buttonStyle(V2PrimaryButtonStyle()).padding(20).background(WorkspaceStyle.surface(scheme))
            }.navigationTitle("Choose avatar").navigationBarTitleDisplayMode(.inline).toolbar {
                ToolbarItem(placement: .topBarTrailing) { Button { dismiss() } label: { Image(systemName: "xmark").frame(width: 44, height: 44) }.accessibilityLabel("Close") }
            }
        }.presentationDragIndicator(.visible)
    }
}
#endif
