#if os(iOS)
import SwiftUI
import UIKit
import DeployCore

/// Fit the whole screen width to the tile and pan to the change, like the boards' tiles.
struct V2ReviewCrop: View {
    let preview: V2ReviewState.Preview?
    let showChanges: Bool
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        GeometryReader { geometry in
            if let preview, let source = preview.after ?? preview.before {
                let crop = preview.metadata.crop
                let width = CGFloat(max(1, preview.metadata.width)), height = CGFloat(max(1, preview.metadata.height))
                let scale = geometry.size.width / width
                let top = min(max(0, (crop.y + crop.h / 2) * scale - geometry.size.height / 2), max(0, height * scale - geometry.size.height))
                ZStack(alignment: .topLeading) {
                    Image(uiImage: source).resizable().frame(width: width * scale, height: height * scale)
                    if showChanges {
                        ForEach(Array(preview.metadata.areas.enumerated()), id: \.offset) { _, area in
                            if let rect = preview.after == nil ? area.before : area.after {
                                Rectangle().stroke(WorkspaceStyle.accent(scheme), lineWidth: 1).frame(width: rect.w * scale, height: rect.h * scale)
                                    .offset(x: rect.x * scale, y: rect.y * scale)
                            }
                        }
                    }
                }.offset(y: -top)
                    .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading).clipped()
            } else { Rectangle().fill(WorkspaceStyle.line(scheme)).redacted(reason: .placeholder) }
        }.background(WorkspaceStyle.surface(scheme)).clipped().accessibilityHidden(true)
    }
}

struct V2ReviewScreenPage: View {
    @Bindable var model: V2ReviewState
    let board: V2DesignReview.Board
    let client: V2Client
    let active: Bool
    @State private var change = 0
    @State private var before = false
    @State private var viewport = CGRect.zero
    @State private var fitCommand = 0
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(spacing: 0) {
            if let preview = model.preview(board) {
                ZStack(alignment: .topTrailing) {
                    V2ReviewZoomPreview(preview: preview, board: board, model: model, change: change,
                                        fitCommand: fitCommand, active: active, before: $before, viewport: $viewport)
                    if before { Text("Before").font(.footnote.bold()).padding(.horizontal, 9).padding(.vertical, 4).background(.regularMaterial, in: Capsule()).padding(12) }
                    if !board.isPhone {
                        VStack(alignment: .trailing, spacing: 8) {
                            if !before { widthChip }
                            Spacer()
                            overview(preview)
                        }.padding(12)
                    }
                }.clipped()
                if !board.isPhone, board.changeKind == "changed", !preview.metadata.areas.isEmpty {
                    changeBar(preview.metadata)
                }
            } else {
                Rectangle().fill(WorkspaceStyle.line(scheme)).overlay {
                    if model.failed.contains(model.key(board)) {
                        Button("Couldn’t draw this board. Retry") { Task { await model.loadPreview(client: client, board: board) } }.font(.footnote).padding()
                    }
                }
            }
        }
        .task(id: model.key(board)) { await model.loadPreview(client: client, board: board) }
        .onChange(of: model.width(board)) { _, _ in change = 0 }
    }
    @ViewBuilder private var widthChip: some View {
        if board.previewWidths.count > 1 {
            Menu {
                ForEach(board.previewWidths, id: \.self) { width in Button(String(width)) { model.widths[board.file] = width } }
            } label: { Text(String(model.width(board))).font(.caption).padding(.horizontal, 9).padding(.vertical, 4).background(.regularMaterial, in: Capsule()) }.accessibilityLabel("Preview width, \(model.width(board))")
        } else { Text(String(model.width(board))).font(.caption).padding(.horizontal, 9).padding(.vertical, 4).background(.regularMaterial, in: Capsule()) }
    }
    private func overview(_ preview: V2ReviewState.Preview) -> some View {
        let ratio = 72 / CGFloat(max(1, preview.metadata.width))
        return Button { fitCommand += 1 } label: {
            ZStack(alignment: .topLeading) {
                if let image = before ? preview.before : preview.after ?? preview.before {
                    Image(uiImage: image).resizable().frame(width: 72, height: CGFloat(preview.metadata.height) * ratio)
                }
                Rectangle().stroke(WorkspaceStyle.accent(scheme), lineWidth: 1.5)
                    .frame(width: min(CGFloat(preview.metadata.width), viewport.width) * ratio, height: min(CGFloat(preview.metadata.height), viewport.height) * ratio)
                    .offset(x: max(0, viewport.minX) * ratio, y: max(0, viewport.minY) * ratio)
            }.frame(width: 72, height: CGFloat(preview.metadata.height) * ratio).clipped().overlay(Rectangle().stroke(WorkspaceStyle.line(scheme)))
        }.buttonStyle(.plain).accessibilityLabel("Fit screen overview")
    }
    private func changeBar(_ preview: V2ReviewPreview) -> some View {
        HStack(spacing: 8) {
            Text("\(change + 1) of \(preview.areas.count) · \(preview.areas[min(change, preview.areas.count - 1)].words)")
                .font(.footnote).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
            Button { change = V2ReviewModel.stepChange(change, by: -1, count: preview.areas.count) } label: { Image(systemName: "chevron.left").frame(width: 44, height: 44) }.disabled(change == 0).accessibilityLabel("Previous change")
            Button { change = V2ReviewModel.stepChange(change, by: 1, count: preview.areas.count) } label: { Image(systemName: "chevron.right").frame(width: 44, height: 44) }.disabled(change >= preview.areas.count - 1).accessibilityLabel("Next change")
        }.padding(.leading, 16).background(WorkspaceStyle.canvas(scheme)).overlay(alignment: .top) { Divider() }
    }
}

/// A single native-coordinate canvas. Swapping revisions changes only pixels and outlines;
/// UIScrollView owns the unchanged zoom scale and content offset.
private struct V2ReviewZoomPreview: UIViewRepresentable {
    let preview: V2ReviewState.Preview
    let board: V2DesignReview.Board
    let model: V2ReviewState
    let change: Int
    let fitCommand: Int
    let active: Bool
    @Environment(\.colorScheme) private var scheme
    @Binding var before: Bool
    @Binding var viewport: CGRect
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> ReviewScrollView {
        let view = ReviewScrollView()
        view.delegate = context.coordinator
        view.bounces = false; view.bouncesZoom = false
        view.showsHorizontalScrollIndicator = false; view.showsVerticalScrollIndicator = false
        view.contentInsetAdjustmentBehavior = .never
        view.addSubview(context.coordinator.canvas)
        context.coordinator.canvas.addSubview(context.coordinator.image)
        let hold = UILongPressGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.hold(_:)))
        hold.minimumPressDuration = 0.3; hold.delegate = context.coordinator
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tap(_:)))
        let double = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTap(_:)))
        double.numberOfTapsRequired = 2; tap.require(toFail: double)
        view.addGestureRecognizer(hold); view.addGestureRecognizer(tap); view.addGestureRecognizer(double)
        context.coordinator.scroll = view
        view.didLayout = { [weak coordinator = context.coordinator] in coordinator?.layout() }
        return view
    }
    func updateUIView(_ view: ReviewScrollView, context: Context) {
        let coordinator = context.coordinator
        coordinator.parent = self
        if !active { coordinator.holding = false }
        coordinator.layout()
        coordinator.draw()
    }
    static func dismantleUIView(_ uiView: ReviewScrollView, coordinator: Coordinator) { uiView.didLayout = nil }

    @MainActor final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        var parent: V2ReviewZoomPreview
        let canvas = UIView()
        let image = UIImageView()
        weak var scroll: UIScrollView?
        var holding = false
        var identity = ""
        var lastChange = -1
        var lastFit = 0
        var marks: [UIView] = []
        var outlines: [CAShapeLayer] = []
        var lastSize = CGSize.zero
        init(_ parent: V2ReviewZoomPreview) { self.parent = parent; super.init() }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { canvas }
        func scrollViewDidScroll(_ scrollView: UIScrollView) { reportViewport() }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { reportViewport() }
        func layout() {
            guard let scroll, scroll.bounds.width > 0, scroll.bounds.height > 0 else { return }
            let metadata = parent.preview.metadata
            let key = "\(parent.board.file)@\(metadata.width)"
            if identity != key {
                identity = key; lastChange = -1
                scroll.setZoomScale(1, animated: false)
                canvas.frame = CGRect(x: 0, y: 0, width: metadata.width, height: metadata.height)
                image.frame = canvas.bounds; image.contentMode = .scaleToFill
                scroll.contentSize = canvas.bounds.size
                scroll.minimumZoomScale = parent.board.isPhone ? 1 : min(1, min(scroll.bounds.width / canvas.bounds.width, scroll.bounds.height / canvas.bounds.height))
                scroll.maximumZoomScale = parent.board.isPhone ? 1 : 4
                // Phone and web both open at native 1:1. The stage clips the surrounding board.
                scroll.zoomScale = 1
                draw()
            }
            if lastSize != scroll.bounds.size {
                lastSize = scroll.bounds.size
                scroll.minimumZoomScale = parent.board.isPhone ? 1 : min(1, min(scroll.bounds.width / canvas.bounds.width, scroll.bounds.height / canvas.bounds.height))
            }
            if lastChange != parent.change {
                lastChange = parent.change
                let areas = metadata.areas
                let rect = areas.indices.contains(parent.change) ? (areas[parent.change].after ?? areas[parent.change].before) : nil
                let point = rect.map { CGPoint(x: max(0, $0.x - 48), y: max(0, $0.y - 48)) }
                    ?? CGPoint(x: parent.board.isPhone ? 0 : max(0, (CGFloat(metadata.width) - scroll.bounds.width) / 2), y: 0)
                pan(to: point)
            }
            if lastFit != parent.fitCommand { lastFit = parent.fitCommand; scroll.setZoomScale(scroll.minimumZoomScale, animated: true) }
            reportViewport()
        }
        func pan(to point: CGPoint) {
            guard let scroll else { return }
            let scale = scroll.zoomScale
            let x = min(max(0, point.x * scale), max(0, scroll.contentSize.width - scroll.bounds.width))
            let y = min(max(0, point.y * scale), max(0, scroll.contentSize.height - scroll.bounds.height))
            scroll.setContentOffset(CGPoint(x: x, y: y), animated: false)
        }
        func draw() {
            image.image = holding ? parent.preview.before : parent.preview.after ?? parent.preview.before
            outlines.forEach { $0.removeFromSuperlayer() }; outlines.removeAll()
            if parent.model.showChanges && parent.board.changeKind == "changed" {
                for area in parent.preview.metadata.areas {
                    guard let rect = holding ? area.before : area.after else { continue }
                    let layer = CAShapeLayer()
                    layer.path = UIBezierPath(roundedRect: CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h), cornerRadius: 4).cgPath
                    layer.strokeColor = UIColor(WorkspaceStyle.accent(parent.scheme)).cgColor; layer.fillColor = UIColor.clear.cgColor; layer.lineWidth = 1.5
                    canvas.layer.addSublayer(layer); outlines.append(layer)
                }
            }
            marks.forEach { $0.removeFromSuperview() }; marks.removeAll()
            let revision = holding || parent.board.isRemoved ? parent.board.before ?? parent.model.review?.before : parent.board.after ?? parent.model.review?.after
            for pin in parent.model.pins where pin.board == parent.board.file && pin.noteId == nil && pin.width == parent.preview.metadata.width && pin.revision == revision {
                addMark(number: pin.number, point: CGPoint(x: pin.x, y: pin.y))
            }
            if let draft = parent.model.draft, draft.board == parent.board.file, draft.noteId == nil, draft.width == parent.preview.metadata.width {
                addMark(number: parent.model.draftNumber, point: CGPoint(x: draft.x, y: draft.y))
            }
            canvas.isAccessibilityElement = false
        }
        func addMark(number: Int, point: CGPoint) {
            let label = UILabel(frame: CGRect(x: point.x - 15, y: point.y - 15, width: 30, height: 30))
            label.text = "\(number)"; label.textAlignment = .center; label.font = .preferredFont(forTextStyle: .subheadline)
            label.textColor = .white; label.backgroundColor = UIColor(WorkspaceStyle.accent(parent.scheme)); label.layer.cornerRadius = 15; label.clipsToBounds = true
            label.layer.borderColor = UIColor.systemBackground.cgColor; label.layer.borderWidth = 2
            label.isAccessibilityElement = true; label.accessibilityLabel = "Pin \(number)"
            label.accessibilityTraits = .button
            label.accessibilityCustomActions = [UIAccessibilityCustomAction(name: "Edit pin") { [weak self] _ in
                guard let self, let pin = self.parent.model.pins.first(where: { $0.number == number }) else { return false }
                self.parent.model.edit(pin); return true
            }]
            canvas.addSubview(label); marks.append(label)
        }
        func reportViewport() {
            guard let scroll else { return }
            let scale = max(0.01, scroll.zoomScale)
            let rect = CGRect(x: scroll.contentOffset.x / scale, y: scroll.contentOffset.y / scale, width: scroll.bounds.width / scale, height: scroll.bounds.height / scale)
            let holding = holding
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                if self.parent.viewport != rect { self.parent.viewport = rect }
                if self.parent.before != holding { self.parent.before = holding }
            }
        }
        @objc func hold(_ gesture: UILongPressGestureRecognizer) {
            guard parent.board.changeKind == "changed", parent.preview.before != nil, parent.preview.after != nil, !parent.model.pinTool, parent.active else { return }
            holding = gesture.state == .began || gesture.state == .changed
            draw(); reportViewport()
        }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll, !parent.model.pinTool, !parent.board.isPhone else { return }
            if scroll.zoomScale > scroll.minimumZoomScale + 0.01 { scroll.setZoomScale(scroll.minimumZoomScale, animated: true) }
            else {
                let point = gesture.location(in: canvas)
                scroll.setZoomScale(1, animated: false)
                pan(to: CGPoint(x: point.x - scroll.bounds.width / 2, y: point.y - scroll.bounds.height / 2))
            }
        }
        @objc func tap(_ gesture: UITapGestureRecognizer) {
            guard parent.active else { return }
            let point = gesture.location(in: canvas)
            guard canvas.bounds.contains(point) else { return }
            let revision = parent.board.isRemoved ? parent.board.before ?? parent.model.review?.before : parent.board.after ?? parent.model.review?.after
            if parent.model.pinTool, let revision {
                parent.model.drop(board: parent.board.file, width: parent.preview.metadata.width, revision: revision, point: point)
            } else if let pin = parent.model.pins.first(where: {
                $0.board == parent.board.file && $0.noteId == nil && $0.width == parent.preview.metadata.width && $0.revision == revision && hypot($0.x - point.x, $0.y - point.y) < 24 / (scroll?.zoomScale ?? 1)
            }) { parent.model.edit(pin) }
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    }
}

private final class ReviewScrollView: UIScrollView {
    var didLayout: (() -> Void)?
    override func layoutSubviews() { super.layoutSubviews(); didLayout?() }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer {
            let velocity = panGestureRecognizer.velocity(in: self)
            if abs(velocity.x) > abs(velocity.y) {
                // At a horizontal edge, hand the outward swipe to the enclosing page view.
                if (velocity.x > 0 && contentOffset.x <= 0) ||
                    (velocity.x < 0 && contentOffset.x >= max(0, contentSize.width - bounds.width)) { return false }
            }
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }
}

struct V2ReviewNotePage: View {
    @Bindable var model: V2ReviewState
    let note: V2DesignReview.Note
    @GestureState private var holding = false
    @ScaledMetric(relativeTo: .body) private var proseSize = 19
    @Environment(\.colorScheme) private var scheme
    private var before: Bool { holding && note.before != nil && note.after != nil && !model.pinTool }
    private var revision: String? { before || note.after == nil ? model.review?.before : model.review?.after }
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                Text([note.page, "Canvas note"].compactMap { $0 }.joined(separator: " · ")).font(.footnote).foregroundStyle(.secondary)
                Text(note.title).font(.title.bold())
                ForEach(Array(((before ? note.before : note.after ?? note.before) ?? []).enumerated()), id: \.offset) { _, line in
                    Text(line.text).font(.system(size: proseSize)).lineSpacing(6).frame(maxWidth: .infinity, alignment: .leading)
                        .background(model.showChanges && line.marked ? WorkspaceStyle.accentSoft(scheme) : .clear)
                }
            }.padding(24).frame(maxWidth: 390, alignment: .leading)
                .contentShape(Rectangle()).coordinateSpace(name: "review-note-" + note.id)
                .onTapGesture(coordinateSpace: .named("review-note-" + note.id)) { point in
                    if model.pinTool, let revision { model.drop(board: "canvas.json", width: 390, revision: revision, point: point, noteId: note.id) }
                }
                .overlay(alignment: .topLeading) {
                    ForEach(model.pins.filter { $0.noteId == note.id && $0.revision == revision }) { pin in
                        Button("\(pin.number)") { model.edit(pin) }.font(.footnote.bold()).frame(width: 30, height: 30)
                            .background(WorkspaceStyle.accent(scheme), in: Circle()).foregroundStyle(WorkspaceStyle.onAction(scheme))
                            .position(x: pin.x, y: pin.y).accessibilityLabel("Pin \(pin.number)")
                    }
                    if let draft = model.draft, draft.noteId == note.id {
                        Text("\(model.draftNumber)").font(.footnote.bold()).frame(width: 30, height: 30)
                            .background(WorkspaceStyle.accent(scheme), in: Circle()).foregroundStyle(WorkspaceStyle.onAction(scheme)).position(x: draft.x, y: draft.y)
                    }
                }.frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .simultaneousGesture(LongPressGesture(minimumDuration: 0.3).sequenced(before: DragGesture(minimumDistance: 0)).updating($holding) { value, state, _ in
            if case .second(true, _) = value { state = true }
        })
        .overlay(alignment: .topTrailing) { if before { Text("Before").font(.footnote.bold()).padding(8).background(.regularMaterial, in: Capsule()).padding(12) } }
    }
}
#endif
