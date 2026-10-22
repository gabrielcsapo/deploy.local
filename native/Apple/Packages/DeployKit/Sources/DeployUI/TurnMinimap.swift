import SwiftUI
import DeployCore

struct TurnMinimap: View {
    let turns: [TranscriptTurn]
    let visible: Set<String>
    let jump: (String) -> Void
    @State private var focusedIndex = 0
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        ScrollViewReader { reader in
        ScrollView(.vertical) {
            VStack(spacing: 0) {
                ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                    Button { focusedIndex = index; jump(turn.id) } label: {
                        Rectangle().fill(visible.contains(turn.id) || (focused && focusedIndex == index) ? WorkspaceStyle.secondaryText(scheme) : WorkspaceStyle.tertiary(scheme))
                            .frame(width: WorkspaceStyle.space2, height: 1)
                            .frame(width: WorkspaceStyle.space6, height: WorkspaceStyle.space4)
                            .contentShape(Rectangle())
                    }.buttonStyle(.plain).focusable(false).id(turn.id)
                        .help(turn.excerpt).accessibilityLabel("Turn \(index + 1): \(turn.excerpt)")
                }
            }
        }.scrollIndicators(.hidden)
            .onChange(of: focusedIndex) { _, index in
                if turns.indices.contains(index) { reader.scrollTo(turns[index].id, anchor: .center) }
            }
            .frame(width: WorkspaceStyle.space6, height: min(CGFloat(turns.count) * WorkspaceStyle.space4, WorkspaceStyle.minimapMaximumHeight))
            .focusable().focused($focused)
            .accessibilityLabel("Conversation turns")
            .accessibilityValue(turns.indices.contains(focusedIndex) ? "Turn \(focusedIndex + 1): \(turns[focusedIndex].excerpt)" : "")
            .help(turns.indices.contains(focusedIndex) ? turns[focusedIndex].excerpt : "Conversation turns")
            .overlay(alignment: .leading) {
                if focused && turns.indices.contains(focusedIndex) {
                    Text(turns[focusedIndex].excerpt).font(WorkspaceStyle.metadata)
                        .padding(WorkspaceStyle.space2).background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
                        .fixedSize(horizontal: true, vertical: false).offset(x: WorkspaceStyle.space6)
                        .allowsHitTesting(false).accessibilityHidden(true)
                }
            }
            .onKeyPress(keys: [.upArrow, .downArrow, .return]) { key in
                guard !turns.isEmpty else { return .ignored }
                focusedIndex = min(focusedIndex, turns.count - 1)
                if key.key == .return { jump(turns[focusedIndex].id) }
                else { focusedIndex = (focusedIndex + (key.key == .upArrow ? turns.count - 1 : 1)) % turns.count }
                return .handled
            }
        }
    }
}

/// The scroll target signal updates visibility without measuring rows on every scroll.
struct TurnVisibility: ViewModifier {
    @Binding var ids: Set<String>
    func body(content: Content) -> some View {
        if #available(macOS 15, iOS 18, *) {
            content.onScrollTargetVisibilityChange(idType: String.self, threshold: 0.01) { ids = Set($0) }
        } else { content }
    }
}
