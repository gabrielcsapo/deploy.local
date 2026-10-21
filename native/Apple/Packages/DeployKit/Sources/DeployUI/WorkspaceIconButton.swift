import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif


enum WorkspaceIconButtonSize {
    case compact, `default`, touch
    var target: CGFloat {
        #if os(iOS)
        WorkspaceStyle.IconAction.touch
        #else
        switch self {
        case .compact: WorkspaceStyle.IconAction.compact
        case .default: WorkspaceStyle.IconAction.standard
        case .touch: WorkspaceStyle.IconAction.touch
        }
        #endif
    }
    var glyph: CGFloat {
        #if os(iOS)
        WorkspaceStyle.IconAction.touchGlyph
        #else
        switch self {
        case .compact: WorkspaceStyle.IconAction.compactGlyph
        case .default: WorkspaceStyle.IconAction.standardGlyph
        case .touch: WorkspaceStyle.IconAction.touchGlyph
        }
        #endif
    }
}

struct WorkspaceIconButton: View {
    let label: String
    let icon: WorkspaceGlyphName
    var size: WorkspaceIconButtonSize = .default
    var pressed: Bool? = nil
    var shortcut: String? = nil
    let action: () -> Void
    @FocusState private var focused: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Button(action: action) {
            WorkspaceGlyph(name: icon, size: size.glyph)
                .frame(width: size.target, height: size.target)
        }
        .buttonStyle(WorkspaceToolbarButtonStyle(selected: pressed == true))
        .focused($focused)
        .overlay { RoundedRectangle(cornerRadius: WorkspaceStyle.Toolbar.radius).stroke(focused ? WorkspaceStyle.accent(scheme) : .clear, lineWidth: 2).allowsHitTesting(false) }
        .help(shortcut.map { "\(label) (\($0))" } ?? label)
        .accessibilityLabel(label)
        .accessibilityValue(pressed.map { $0 ? "On" : "Off" } ?? "")
        .accessibilityAddTraits(pressed == true ? .isSelected : [])
    }
}

struct WorkspaceActionCluster<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View { HStack(spacing: WorkspaceStyle.IconAction.gap, content: content) }
}

struct WorkspaceCopyButton: View {
    let label: String
    let text: String
    var size: WorkspaceIconButtonSize = .compact
    @State private var copied = false
    @State private var fallback = false
    @State private var resetTask: Task<Void, Never>?
    var body: some View {
        WorkspaceIconButton(label: label, icon: copied ? .check : .copy, size: size) {
            resetTask?.cancel()
            #if os(macOS)
            NSPasteboard.general.clearContents()
            let success = NSPasteboard.general.setString(text, forType: .string)
            #else
            UIPasteboard.general.string = text
            let success = true
            #endif
            copied = success
            fallback = !success
            if success {
                AccessibilityNotification.Announcement("Copied").post()
                resetTask = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(1500))
                    guard !Task.isCancelled else { return }
                    copied = false
                }
            }
        }
        .popover(isPresented: $fallback) {
            VStack(alignment: .leading) {
                Text("Select and copy the text")
                Text(text).textSelection(.enabled)
                WorkspaceIconButton(label: "Close copy fallback", icon: .close) { fallback = false }
            }.padding()
        }
        .onDisappear { resetTask?.cancel() }
    }
}
