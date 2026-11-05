#if os(iOS)
import SwiftUI
import UIKit
import DeployCore

struct V2ReviewCompareControl: UIViewRepresentable {
    let selected: Bool
    let enabled: Bool
    let reason: String
    let tap: () -> Void
    let hold: (Bool) -> Void
    @Environment(\.colorScheme) private var scheme
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> UIButton {
        let button = UIButton(type: .system)
        let press = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.press(_:)))
        press.minimumPressDuration = 0.3
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap))
        tap.require(toFail: press)
        button.addGestureRecognizer(press); button.addGestureRecognizer(tap)
        button.addTarget(context.coordinator, action: #selector(Coordinator.tap), for: .primaryActionTriggered)
        return button
    }
    func updateUIView(_ button: UIButton, context: Context) {
        context.coordinator.parent = self
        var configuration = UIButton.Configuration.plain()
        configuration.title = "Compare"; configuration.image = UIImage(systemName: "rectangle.lefthalf.inset.filled")
        configuration.imagePadding = 6
        configuration.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { input in
            var output = input; output.font = .preferredFont(forTextStyle: .footnote); return output
        }
        configuration.baseForegroundColor = UIColor(enabled ? WorkspaceStyle.text(scheme) : WorkspaceStyle.secondary(scheme))
        configuration.background.backgroundColor = UIColor(selected ? WorkspaceStyle.line(scheme) : WorkspaceStyle.surface(scheme))
        configuration.background.cornerRadius = 8
        configuration.background.strokeColor = UIColor(WorkspaceStyle.line(scheme)); configuration.background.strokeWidth = 1
        button.configuration = configuration; button.isEnabled = enabled; button.titleLabel?.numberOfLines = 1
        button.accessibilityLabel = "Compare"; button.accessibilityHint = reason.isEmpty ? "Hold to peek at Before" : reason
        button.accessibilityTraits = !enabled ? [.button, .notEnabled] : selected ? [.button, .selected] : [.button]
    }
    @MainActor final class Coordinator: NSObject {
        var parent: V2ReviewCompareControl
        init(_ parent: V2ReviewCompareControl) { self.parent = parent }
        @objc func tap() { if parent.enabled { parent.tap() } }
        @objc func press(_ gesture: UILongPressGestureRecognizer) {
            parent.hold(parent.enabled && (gesture.state == .began || gesture.state == .changed))
        }
    }
}

struct V2ReviewDrawingThumbnail: View {
    let model: V2ReviewState
    let drawing: V2ReviewDrawing
    let client: V2Client
    @State private var original: UIImage?
    @Environment(\.colorScheme) private var scheme
    private var source: UIImage? {
        let file = model.editing?.board ?? model.draft?.board
        let revision = model.editing?.revision ?? model.draft?.revision
        guard let board = model.review?.boards.first(where: { $0.file == file }),
              let preview = model.previews["\(board.file)@\(drawing.nativeWidth)@\(model.displayScale)"], preview.metadata.height == drawing.nativeHeight else { return original }
        if revision == (board.before ?? model.review?.before) { return preview.before ?? original }
        if revision == (board.after ?? model.review?.after) { return preview.after ?? original }
        return original
    }
    var body: some View {
        Canvas { context, size in
            let points = drawing.strokes.flatMap { $0 }
            let width = Double(drawing.nativeWidth), height = Double(drawing.nativeHeight)
            let left = (points.map(\.x).min() ?? 0) * width, right = (points.map(\.x).max() ?? 1) * width
            let top = (points.map(\.y).min() ?? 0) * height, bottom = (points.map(\.y).max() ?? 1) * height
            let scale = min(size.width / max(1, right - left + 32), size.height / max(1, bottom - top + 32))
            context.translateBy(x: size.width / 2 - (left + right) / 2 * scale, y: size.height / 2 - (top + bottom) / 2 * scale)
            context.scaleBy(x: scale, y: scale)
            if let source { context.draw(Image(uiImage: source), in: CGRect(x: 0, y: 0, width: width, height: height)) }
            for stroke in drawing.strokes {
                var path = Path()
                for (index, point) in stroke.enumerated() {
                    let p = CGPoint(x: point.x * width, y: point.y * height)
                    if index == 0 { path.move(to: p) } else { path.addLine(to: p) }
                }
                if stroke.count == 1, let point = stroke.first { path.addLine(to: CGPoint(x: point.x * width, y: point.y * height)) }
                context.stroke(path, with: .color(WorkspaceStyle.accent(scheme)), style: StrokeStyle(lineWidth: drawing.weight, lineCap: .round, lineJoin: .round))
            }
        }.background(WorkspaceStyle.surface(scheme)).accessibilityLabel("Drawing on the screen")
            .task(id: model.editing?.id) {
                guard source == nil, let pin = model.editing else { return }
                if let data = try? await client.designImage(project: model.project, board: pin.board, commit: pin.revision, width: drawing.nativeWidth, height: drawing.nativeHeight), !Task.isCancelled { original = UIImage(data: data) }
            }
    }
}
#endif
