import SwiftUI
import DeployCore

/// Ticks for each prompt. Hovering works like a Dock lens: ticks near the pointer lengthen,
/// and the closest one previews its prompt and the reply that followed.
struct TurnMinimap: View {
    let turns: [TranscriptTurn]
    let visible: Set<String>
    let jump: (String) -> Void
    @State private var focusedIndex = 0
    /// The pointer as a fractional row while hovering.
    @State private var pointer: CGFloat?
    @State private var keyboard = false
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let reach: CGFloat = 2.5
    private var pitch: CGFloat { min(WorkspaceStyle.space2, WorkspaceStyle.minimapMaximumHeight / CGFloat(max(turns.count, 1))) }
    private var lens: CGFloat? { keyboard && focused ? CGFloat(focusedIndex) : pointer }
    private var current: Int? {
        guard let lens, !turns.isEmpty else { return nil }
        return min(turns.count - 1, max(0, Int(lens.rounded())))
    }
    private func magnify(_ index: Int) -> CGFloat {
        guard let lens else { return 0 }
        return max(0, 1 - abs(CGFloat(index) - lens) / Self.reach)
    }
    private func ink(_ index: Int, _ turn: TranscriptTurn) -> Color {
        if index == current { return WorkspaceStyle.text(scheme) }
        return visible.contains(turn.id) ? WorkspaceStyle.tertiary(scheme) : WorkspaceStyle.line(scheme)
    }
    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
                Button { focusedIndex = index; jump(turn.id) } label: {
                    Capsule().fill(ink(index, turn))
                        .frame(width: WorkspaceStyle.space2 + WorkspaceStyle.space4 * magnify(index), height: index == current ? 2 : 1)
                        .padding(.leading, WorkspaceStyle.space2)
                        .frame(width: WorkspaceStyle.space8, height: pitch, alignment: .leading)
                        .contentShape(Rectangle())
                }.buttonStyle(.plain).focusable(false)
                    .accessibilityLabel("Turn \(index + 1): \(turn.excerpt)")
            }
        }
        .padding(.vertical, WorkspaceStyle.space2)
        .animation(WorkspaceStyle.Motion.fast(reduceMotion: reduceMotion), value: lens)
        .contentShape(Rectangle())
        .onContinuousHover { phase in
            switch phase {
            case .active(let location):
                keyboard = false
                pointer = (location.y - WorkspaceStyle.space2) / pitch - 0.5
            case .ended: pointer = nil
            }
        }
        .focusable().focused($focused).focusEffectDisabled()
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Conversation turns")
        .accessibilityValue(turns.indices.contains(focusedIndex) ? "Turn \(focusedIndex + 1): \(turns[focusedIndex].excerpt)" : "")
        .overlay(alignment: .topLeading) { preview }
        .onKeyPress(keys: [.upArrow, .downArrow, .return]) { key in
            guard !turns.isEmpty else { return .ignored }
            keyboard = true
            focusedIndex = min(focusedIndex, turns.count - 1)
            if key.key == .return { jump(turns[focusedIndex].id) }
            else { focusedIndex = (focusedIndex + (key.key == .upArrow ? turns.count - 1 : 1)) % turns.count }
            return .handled
        }
    }

    @ViewBuilder private var preview: some View {
        if let current, turns.indices.contains(current) {
            let turn = turns[current]
            let center = WorkspaceStyle.space2 + (CGFloat(current) + 0.5) * pitch
            VStack(alignment: .leading, spacing: WorkspaceStyle.space1) {
                Text(turn.prompt.isEmpty ? turn.excerpt : turn.prompt)
                    .font(WorkspaceStyle.metadata.weight(.semibold)).foregroundStyle(WorkspaceStyle.text(scheme)).lineLimit(1)
                if !turn.reply.isEmpty {
                    Text(turn.reply).font(WorkspaceStyle.metadata).foregroundStyle(WorkspaceStyle.secondaryText(scheme)).lineLimit(3)
                }
            }
            .frame(width: WorkspaceStyle.space8 * 10, alignment: .leading)
            .padding(WorkspaceStyle.space3)
            .background(WorkspaceStyle.raised(scheme), in: RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius))
            .overlay(RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius).strokeBorder(WorkspaceStyle.line(scheme)))
            .shadow(color: .black.opacity(scheme == .dark ? 0.38 : 0.09), radius: 18, x: 0, y: 8)
            .fixedSize(horizontal: false, vertical: true)
            .alignmentGuide(.top) { dimensions in dimensions[VerticalAlignment.center] - center }
            .alignmentGuide(.leading) { _ in -(WorkspaceStyle.space8 + WorkspaceStyle.space2) }
            .allowsHitTesting(false).accessibilityHidden(true)
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
