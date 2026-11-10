#if os(iOS)
import SwiftUI
import UIKit
import DeployCore

/// Fit the whole screen width to the tile and pan to the change, like the boards' tiles.
/// `side` shows one revision on its own, panned to where the change is on that side; without it
/// the tile shows After, or Before for a removed screen.
struct V2ReviewCrop: View {
    let preview: V2ReviewState.Preview?
    let showChanges: Bool
    var side: String? = nil
    var card = false
    @Environment(\.colorScheme) private var scheme
    private func image(_ preview: V2ReviewState.Preview) -> UIImage? {
        switch side {
        case "before": preview.before
        case "after": preview.after
        default: preview.after ?? preview.before
        }
    }
    var body: some View {
        GeometryReader { geometry in
            if let preview, let source = image(preview) {
                let crop = card ? V2ReviewModel.cardRegion(preview.metadata, side: side ?? "after", aspect: Double(geometry.size.width / max(1, geometry.size.height))) : preview.metadata.crop
                let width = CGFloat(max(1, preview.metadata.width)), height = CGFloat(max(1, preview.metadata.height))
                let scale = geometry.size.width / (card ? CGFloat(crop.w) : width)
                let top = min(max(0, (crop.y + crop.h / 2) * scale - geometry.size.height / 2), max(0, height * scale - geometry.size.height))
                ZStack(alignment: .topLeading) {
                    Image(uiImage: source).resizable().frame(width: width * scale, height: height * scale)
                    if showChanges {
                        ForEach(Array(preview.metadata.areas.enumerated()), id: \.offset) { _, area in
                            if let rect = (side ?? (preview.after == nil ? "before" : "after")) == "before" ? area.before : area.after {
                                Rectangle().stroke(WorkspaceStyle.accent(scheme), lineWidth: 1).frame(width: rect.w * scale, height: rect.h * scale)
                                    .offset(x: rect.x * scale, y: rect.y * scale)
                            }
                        }
                    }
                }.offset(x: card ? -crop.x * scale : 0, y: card ? -crop.y * scale : -top)
                    .frame(width: geometry.size.width, height: geometry.size.height, alignment: .topLeading).clipped()
            } else { V2ReviewShimmer() }
        }.background(WorkspaceStyle.surface(scheme)).clipped().accessibilityHidden(true)
    }
}

struct V2ReviewScreenPage: View {
    @Bindable var model: V2ReviewState
    let board: V2DesignReview.Board
    let client: V2Client
    let active: Bool
    @State private var change = 0
    @State private var viewport = CGRect.zero
    @State private var fitCommand = 0
    @State private var slow = false
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        VStack(spacing: 0) {
            if let preview = model.preview(board) {
                ZStack(alignment: .topTrailing) {
                    V2ReviewZoomPreview(preview: preview, board: board, model: model, change: change,
                                        fitCommand: fitCommand, active: active, viewport: $viewport)
                    if model.peeking { Text("Before").font(.footnote.bold()).padding(.horizontal, 9).padding(.vertical, 4).background(.regularMaterial, in: Capsule()).padding(12) }
                    if model.canCompare(board) && model.comparisonMode == "slider" && !model.peeking {
                        GeometryReader { geometry in
                            ZStack(alignment: .topLeading) {
                                HStack {
                                    revisionLabel("Old"); Spacer(); revisionLabel("New")
                                }.padding(12)
                                Rectangle().fill(WorkspaceStyle.text(scheme)).frame(width: 2).overlay {
                                    Image(systemName: "arrow.left.and.right").font(.body).frame(width: 44, height: 44)
                                        .background(WorkspaceStyle.surface(scheme), in: Circle()).overlay(Circle().stroke(WorkspaceStyle.text(scheme)))
                                }.frame(width: 44).contentShape(Rectangle())
                                    .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("reviewWipe")).onChanged { value in
                                        model.amount = min(1, max(0, 1 - value.location.x / geometry.size.width))
                                    })
                                    .position(x: geometry.size.width * (1 - model.amount), y: geometry.size.height / 2)
                            }.coordinateSpace(name: "reviewWipe")
                        }.allowsHitTesting(!model.pinTool && !model.areaTool && !model.drawing)
                            .accessibilityElement(children: .ignore).accessibilityLabel("Before percentage")
                            .accessibilityValue("\(Int((1 - model.amount) * 100)) percent")
                            .accessibilityAdjustableAction { direction in model.amount = min(1, max(0, model.amount + (direction == .increment ? -0.05 : 0.05))) }
                    }
                    if let pin = model.selectedPin, pin.board == board.file, model.showChanges {
                        VStack {
                            Spacer()
                            Button { model.edit(pin); model.selectedPin = nil } label: {
                                HStack(alignment: .top, spacing: 12) {
                                    Text("\(pin.number)").font(.footnote).frame(width: 24, height: 24).overlay(Circle().stroke(WorkspaceStyle.line(scheme)))
                                    VStack(alignment: .leading, spacing: 6) {
                                        Text(pin.text).font(.body)
                                        Text("Drawing saved · Ask for \(V2ReviewModel.count(model.pins.filter { !$0.resolved }.count, "change"))").font(.footnote).foregroundStyle(.secondary)
                                    }
                                }.frame(maxWidth: .infinity, alignment: .leading).padding(16)
                                    .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
                                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
                            }.buttonStyle(.plain).padding(.horizontal, 16).padding(.bottom, 20)
                        }
                    }
                }.clipped()
            } else {
                V2ReviewShimmer().overlay {
                    if model.failed.contains(model.key(board)) {
                        Button("Couldn’t draw this board. Retry") { Task { await model.loadPreview(client: client, board: board) } }.font(.footnote).padding()
                    } else if slow { Text("Screen preview is taking longer than usual.").font(.footnote).padding() }
                }
            }
        }
        .task(id: "slow-" + model.key(board)) { slow = false; try? await Task.sleep(for: .seconds(10)); if !Task.isCancelled { slow = true } }
        .task(id: model.key(board)) { await model.loadPreview(client: client, board: board) }
        .onChange(of: model.width(board)) { _, _ in change = 0 }
    }
    private func revisionLabel(_ title: String) -> some View {
        Text(title).font(.footnote.bold()).fixedSize().padding(.horizontal, 9).padding(.vertical, 4).background(.regularMaterial, in: Capsule())
    }
    private func overview(_ preview: V2ReviewState.Preview) -> some View {
        let ratio = 72 / CGFloat(max(1, preview.metadata.width))
        return Button { fitCommand += 1 } label: {
            ZStack(alignment: .topLeading) {
                if let image = model.peeking ? preview.before : preview.after ?? preview.before {
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

/// Both revisions and annotations share one native-coordinate scroll canvas.
private struct V2ReviewZoomPreview: UIViewRepresentable {
    let preview: V2ReviewState.Preview
    let board: V2DesignReview.Board
    let model: V2ReviewState
    let change: Int
    let fitCommand: Int
    let active: Bool
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var viewport: CGRect
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> ReviewScrollView {
        let view = ReviewScrollView(), coordinator = context.coordinator
        view.delegate = coordinator; view.bounces = false; view.bouncesZoom = false
        view.showsHorizontalScrollIndicator = false; view.showsVerticalScrollIndicator = false
        view.contentInsetAdjustmentBehavior = .never
        view.addSubview(coordinator.canvas)
        for side in 0...1 { coordinator.canvas.addSubview(coordinator.sides[side]); coordinator.sides[side].addSubview(coordinator.images[side]) }
        let hold = UILongPressGestureRecognizer(target: coordinator, action: #selector(Coordinator.hold(_:)))
        hold.minimumPressDuration = 0.5; hold.delegate = coordinator
        let tap = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.tap(_:)))
        let double = UITapGestureRecognizer(target: coordinator, action: #selector(Coordinator.doubleTap(_:)))
        double.numberOfTapsRequired = 2; tap.require(toFail: double)
        tap.delegate = coordinator; double.delegate = coordinator
        let draw = UIPanGestureRecognizer(target: coordinator, action: #selector(Coordinator.drag(_:)))
        draw.maximumNumberOfTouches = 1; draw.delegate = coordinator
        view.addGestureRecognizer(hold); view.addGestureRecognizer(tap); view.addGestureRecognizer(double); view.addGestureRecognizer(draw)
        view.panGestureRecognizer.require(toFail: draw)
        coordinator.scroll = view
        view.didLayout = { [weak coordinator] in coordinator?.layout() }
        view.adjustDivider = { [weak coordinator] delta in
            guard let coordinator, coordinator.parent.model.comparing else { return }
            coordinator.parent.model.divider = min(1, max(0, coordinator.parent.model.divider + delta))
        }
        return view
    }
    func updateUIView(_ view: ReviewScrollView, context: Context) {
        let coordinator = context.coordinator
        if coordinator.parent.active && !active { coordinator.unlockPager() }
        coordinator.parent = self
        view.modeLocked = active && (model.comparing || model.drawing || model.areaTool)
        view.panGestureRecognizer.minimumNumberOfTouches = view.modeLocked ? 2 : 1
        coordinator.layout(); coordinator.draw(); coordinator.lockPager()
        if active && model.comparing && !view.isFirstResponder { view.becomeFirstResponder() }
        if !model.comparing && view.isFirstResponder { view.resignFirstResponder() }
    }
    static func dismantleUIView(_ view: ReviewScrollView, coordinator: Coordinator) { coordinator.unlockPager() }
    final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        var parent: V2ReviewZoomPreview
        let canvas = UIView()
        let sides = [UIView(), UIView()]
        let images = [UIImageView(), UIImageView()]
        weak var scroll: ReviewScrollView?
        weak var pager: UIScrollView?
        var identity = ""
        var lastChange = -1
        var lastFit = 0
        var lastRestore = 0
        var lastBounds = CGSize.zero
        var layingOut = false
        var initialOffset = CGPoint.zero
        var marks: [UIView] = []
        var outlines: [CAShapeLayer] = []
        var stroke: [V2ReviewDrawing.Point] = []
        var areaStart: CGPoint?
        var areaRect: V2ReviewRect?
        init(_ parent: V2ReviewZoomPreview) { self.parent = parent; super.init() }
        func viewForZooming(in scrollView: UIScrollView) -> UIView? { canvas }
        func scrollViewDidScroll(_ scrollView: UIScrollView) { clipSides(); reportViewport(); lockPager() }
        func scrollViewDidZoom(_ scrollView: UIScrollView) { centre(); clipSides(); reportViewport(); lockPager() }
        // An animated zoom or a flick settles after the last scroll callback; decide about paging again
        // once it has, or a screen that just came to rest fitted would stay locked.
        func scrollViewDidEndZooming(_ scrollView: UIScrollView, with view: UIView?, atScale scale: CGFloat) { centre(); clipSides(); reportViewport(); lockPager() }
        func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { lockPager() }
        func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) { if !decelerate { lockPager() } }
        func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) { lockPager() }
        /// The screen has not been moved or zoomed since it opened.
        var openedHere: Bool {
            guard let scroll else { return false }
            return abs(scroll.zoomScale - 1) < 0.01 && abs(scroll.contentOffset.x - initialOffset.x) < 1 && abs(scroll.contentOffset.y - initialOffset.y) < 1
        }
        /// A screen zoomed out smaller than the window sits in its middle.
        func centre() {
            guard let scroll else { return }
            var frame = canvas.frame
            frame.origin = CGPoint(x: V2ReviewZoom.centred(content: Double(frame.width), viewport: Double(scroll.bounds.width)),
                                   y: V2ReviewZoom.centred(content: Double(frame.height), viewport: Double(scroll.bounds.height)))
            if canvas.frame.origin != frame.origin { canvas.frame = frame }
        }
        func layout() {
            guard let scroll, !layingOut, scroll.bounds.width > 0, scroll.bounds.height > 0 else { return }
            layingOut = true
            defer { layingOut = false }
            let metadata = parent.preview.metadata, key = parent.model.key(parent.board)
            // Pinching out, double-tap and Fit go as far as the whole width of the screen; the screen
            // still opens at its real size. Kept current, because the window can change size.
            let fit = CGFloat(V2ReviewZoom.fit(content: Double(metadata.width), viewport: Double(scroll.bounds.width)))
            let sameScreen = identity == key
            let resized = sameScreen && lastBounds != .zero && lastBounds != scroll.bounds.size
            let whereItOpened = sameScreen && openedHere
            if abs(scroll.minimumZoomScale - fit) > 0.0001 {
                // Rotation: a fitted screen stays fitted in the new window.
                let next = CGFloat(V2ReviewZoom.afterResize(zoom: Double(scroll.zoomScale), oldMinimum: Double(scroll.minimumZoomScale), newMinimum: Double(fit)))
                scroll.minimumZoomScale = fit
                if sameScreen, abs(next - scroll.zoomScale) > 0.0001 { scroll.setZoomScale(next, animated: false) }
            }
            if identity != key {
                identity = key; lastChange = parent.change
                scroll.setZoomScale(1, animated: false)
                canvas.frame = CGRect(x: 0, y: 0, width: metadata.width, height: metadata.height)
                for side in 0...1 { sides[side].frame = canvas.bounds; images[side].frame = canvas.bounds; images[side].contentMode = .scaleToFill }
                scroll.contentSize = canvas.bounds.size
                scroll.maximumZoomScale = 4
                panToChange()
                initialOffset = scroll.contentOffset
                if let crop = parent.model.crops[key] { scroll.setZoomScale(crop.scale, animated: false); scroll.setContentOffset(crop.offset, animated: false) }
            }
            if resized {
                // The window changed size. An untouched screen goes back to where it opens in the new
                // window; a moved one keeps its place, pulled back inside the screen.
                if whereItOpened { panToChange(); initialOffset = scroll.contentOffset }
                else { pan(to: CGPoint(x: scroll.contentOffset.x / max(0.01, scroll.zoomScale), y: scroll.contentOffset.y / max(0.01, scroll.zoomScale))) }
            }
            lastBounds = scroll.bounds.size
            centre()
            if lastRestore != parent.model.restoreCrop {
                lastRestore = parent.model.restoreCrop
                if let crop = parent.model.crops[key] { scroll.setZoomScale(crop.scale, animated: false); scroll.setContentOffset(crop.offset, animated: false) }
            }
            if lastChange != parent.change { lastChange = parent.change; panToChange() }
            if lastFit != parent.fitCommand { lastFit = parent.fitCommand; scroll.setZoomScale(scroll.minimumZoomScale, animated: !parent.reduceMotion) }
            clipSides(); reportViewport()
        }
        func panToChange() {
            guard let scroll else { return }
            let areas = parent.preview.metadata.areas
            let rect = areas.indices.contains(parent.change) ? (areas[parent.change].after ?? areas[parent.change].before) : nil
            pan(to: rect.map { CGPoint(x: parent.board.isPhone ? 0 : max(0, $0.x - 48), y: max(0, $0.y - 48)) }
                ?? CGPoint(x: parent.board.isPhone ? 0 : max(0, (canvas.bounds.width - scroll.bounds.width) / 2), y: 0))
        }
        func pan(to point: CGPoint) {
            guard let scroll else { return }
            let scale = scroll.zoomScale
            scroll.setContentOffset(CGPoint(x: min(max(0, point.x * scale), max(0, scroll.contentSize.width - scroll.bounds.width)),
                                           y: min(max(0, point.y * scale), max(0, scroll.contentSize.height - scroll.bounds.height))), animated: false)
        }
        func clipSides() {
            guard let scroll else { return }
            let model = parent.model
            let paired = parent.preview.before != nil && parent.preview.after != nil && !model.drawing
            let amount = model.comparing ? 1 - model.divider : model.amount
            // Measured in the screen's own points; a centred screen starts right of the window's edge.
            let split = (scroll.contentOffset.x + scroll.bounds.width * (1 - amount) - canvas.frame.origin.x) / max(0.01, scroll.zoomScale)
            CATransaction.begin(); CATransaction.setDisableActions(true)
            // Before sits above After so Overlay fades the old image over the new one.
            canvas.bringSubviewToFront(sides[0])
            for side in 0...1 {
                let showingBefore = model.peeking || parent.preview.after == nil
                sides[side].isHidden = paired && !model.peeking ? false : (side == 0) != showingBefore
                sides[side].alpha = paired && !model.peeking && model.comparisonMode == "onion" && side == 0 ? 1 - amount : 1
                let mask = CAShapeLayer()
                let rect = paired && !model.peeking && model.comparisonMode == "slider" && side == 0
                    ? CGRect(x: 0, y: 0, width: max(0, split), height: canvas.bounds.height)
                    : canvas.bounds
                mask.path = UIBezierPath(rect: rect).cgPath; sides[side].layer.mask = mask
            }
            CATransaction.commit()
        }
        func draw() {
            images[0].image = parent.preview.before; images[1].image = parent.preview.after
            outlines.forEach { $0.removeFromSuperlayer() }; outlines.removeAll()
            marks.forEach { $0.removeFromSuperview() }; marks.removeAll()
            for side in 0...1 {
                let revision = side == 0 ? parent.board.before ?? parent.model.review?.before : parent.board.after ?? parent.model.review?.after
                if parent.model.showChanges && parent.board.changeKind == "changed" {
                    for area in parent.preview.metadata.areas {
                        guard let rect = side == 0 ? area.before : area.after else { continue }
                        addPath(UIBezierPath(roundedRect: CGRect(x: rect.x, y: rect.y, width: rect.w, height: rect.h), cornerRadius: 4), weight: 1.5, side: side)
                    }
                }
                for pin in parent.model.pins where pin.board == parent.board.file && pin.noteId == nil && pin.placement(in: parent.preview.metadata, side: side == 0 ? "before" : "after") != nil && pin.revision == revision && (parent.model.showChanges || parent.model.editing?.id == pin.id) {
                    if let drawing = pin.drawing {
                        guard drawing.nativeWidth == parent.preview.metadata.width, drawing.nativeHeight == parent.preview.metadata.height else { continue }
                        drawStrokes(drawing.strokes, weight: drawing.weight, side: side)
                    }
                    guard let placed = pin.placement(in: parent.preview.metadata, side: side == 0 ? "before" : "after") else { continue }
                    if let area = placed.area { drawArea(area, side: side) }
                    addMark(number: pin.number, point: CGPoint(x: placed.point.x, y: placed.point.y), side: side, size: pin.drawing == nil ? 30 : 44)
                }
                if let draft = parent.model.draft, draft.board == parent.board.file, draft.width == parent.preview.metadata.width, draft.revision == revision {
                    if let drawing = draft.drawing {
                        drawStrokes(drawing.strokes + (stroke.isEmpty ? [] : [stroke]), weight: drawing.weight, side: side)
                    }
                    if let area = draft.area { drawArea(area, side: side) }
                    if draft.drawing == nil || parent.model.pinSheet { addMark(number: parent.model.draftNumber, point: CGPoint(x: draft.x, y: draft.y), side: side) }
                }
            }
            if let areaRect { drawArea(areaRect, side: parent.board.isRemoved ? 0 : 1) }
            clipSides()
        }
        func drawArea(_ area: V2ReviewRect, side: Int) {
            addPath(UIBezierPath(rect: CGRect(x: area.x, y: area.y, width: area.w, height: area.h)), weight: 1.5, side: side)
        }
        func drawStrokes(_ strokes: [[V2ReviewDrawing.Point]], weight: Double, side: Int) {
            for stroke in strokes {
                let path = UIBezierPath()
                for (index, point) in stroke.enumerated() {
                    let point = CGPoint(x: point.x * canvas.bounds.width, y: point.y * canvas.bounds.height)
                    if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                }
                if stroke.count == 1 { path.addLine(to: path.currentPoint) }
                addPath(path, weight: weight, side: side)
            }
        }
        func addPath(_ path: UIBezierPath, weight: Double, side: Int) {
            let layer = CAShapeLayer(); layer.path = path.cgPath
            layer.strokeColor = UIColor(WorkspaceStyle.accent(parent.scheme)).cgColor; layer.fillColor = UIColor.clear.cgColor
            layer.lineWidth = weight; layer.lineCap = .round; layer.lineJoin = .round
            sides[side].layer.addSublayer(layer); outlines.append(layer)
        }
        func addMark(number: Int, point: CGPoint, side: Int, size: CGFloat = 30) {
            let label = UILabel(frame: CGRect(x: point.x - size / 2, y: point.y - size / 2, width: size, height: size))
            label.text = "\(number)"; label.textAlignment = .center; label.font = .preferredFont(forTextStyle: .subheadline)
            label.textColor = .white; label.backgroundColor = UIColor(WorkspaceStyle.accent(parent.scheme)); label.layer.cornerRadius = size / 2; label.clipsToBounds = true
            label.layer.borderColor = UIColor.systemBackground.cgColor; label.layer.borderWidth = 2
            label.isAccessibilityElement = true; label.accessibilityLabel = "Pin \(number)"; label.accessibilityTraits = .button
            label.accessibilityCustomActions = [UIAccessibilityCustomAction(name: "Edit pin") { [weak self] _ in
                guard let self, let pin = self.parent.model.pins.first(where: { $0.number == number }) else { return false }
                self.parent.model.edit(pin); return true
            }]
            sides[side].addSubview(label); marks.append(label)
        }
        func reportViewport() {
            guard let scroll, !identity.isEmpty else { return }
            let scale = max(0.01, scroll.zoomScale), offset = scroll.contentOffset, key = identity, restore = parent.model.restoreCrop
            let rect = CGRect(x: offset.x / scale, y: offset.y / scale, width: scroll.bounds.width / scale, height: scroll.bounds.height / scale)
            DispatchQueue.main.async { [weak self] in
                guard let self, self.identity == key, self.parent.model.restoreCrop == restore else { return }
                if self.parent.viewport != rect { self.parent.viewport = rect }
                if self.parent.active && self.parent.model.viewports[key] != rect { self.parent.model.viewports[key] = rect }
                if self.parent.active && !self.layingOut {
                    let previous = self.parent.model.crops[key]
                    if previous?.scale != scale || previous?.offset != offset { self.parent.model.crops[key] = (scale, offset) }
                }
            }
        }
        func lockPager() {
            guard let scroll, parent.active else { return }
            var ancestor = scroll.superview
            while let view = ancestor {
                if let outer = view as? UIScrollView { pager = outer; break }
                ancestor = view.superview
            }
            let pages = V2ReviewZoom.passesPaging(zoom: Double(scroll.zoomScale), minimum: Double(scroll.minimumZoomScale), whereItOpened: openedHere)
            scroll.passPaging = pages && !parent.model.comparing && !parent.model.drawing && !parent.model.areaTool
            pager?.isScrollEnabled = scroll.passPaging
            let allowed = scroll.passPaging
            if parent.model.pagingAllowed != allowed {
                DispatchQueue.main.async { [weak self] in
                    guard let self, self.parent.active else { return }
                    self.parent.model.pagingAllowed = allowed
                }
            }
        }
        func unlockPager() { pager?.isScrollEnabled = true }
        @objc func drag(_ gesture: UIPanGestureRecognizer) {
            guard let scroll, parent.active else { return }
            if parent.model.areaTool {
                let location = gesture.location(in: canvas)
                let point = CGPoint(x: min(canvas.bounds.width, max(0, location.x)), y: min(canvas.bounds.height, max(0, location.y)))
                if gesture.state == .began { areaStart = point }
                if gesture.state == .cancelled || gesture.state == .failed { areaStart = nil; areaRect = nil; draw(); return }
                if let start = areaStart {
                    areaRect = .init(x: min(start.x, point.x), y: min(start.y, point.y), w: abs(start.x - point.x), h: abs(start.y - point.y))
                }
                if gesture.state == .ended {
                    if let area = areaRect, area.w > 1, area.h > 1 {
                        let revision = parent.board.isRemoved ? parent.board.before ?? parent.model.review?.before : parent.board.after ?? parent.model.review?.after
                        if let revision { parent.model.drop(board: parent.board.file, width: parent.preview.metadata.width, revision: revision, point: CGPoint(x: area.x + area.w / 2, y: area.y + area.h / 2), area: area) }
                    }
                    areaStart = nil; areaRect = nil
                }
                draw(); return
            }
            if parent.model.comparing {
                parent.model.divider = min(1, max(0, (gesture.location(in: scroll).x - scroll.bounds.minX) / scroll.bounds.width))
                clipSides(); return
            }
            guard parent.model.drawing else { return }
            if gesture.state == .cancelled || gesture.state == .failed { stroke = []; draw(); return }
            let point = gesture.location(in: canvas)
            let normalized = V2ReviewDrawing.Point(x: min(1, max(0, point.x / canvas.bounds.width)), y: min(1, max(0, point.y / canvas.bounds.height)))
            if gesture.state == .began { stroke = [] }
            let saved = parent.model.draft?.drawing?.strokes ?? []
            if stroke.count < 4096 && saved.count < 128 && saved.reduce(0, { $0 + $1.count }) + stroke.count < 16384 { stroke.append(normalized) }
            if gesture.state == .ended { parent.model.appendStroke(stroke); stroke = [] }
            draw()
        }
        @objc func hold(_ gesture: UILongPressGestureRecognizer) {
            guard gesture.state == .began, parent.active, !parent.model.comparing, !parent.model.drawing else { return }
            drop(at: gesture.location(in: canvas))
        }
        func drop(at point: CGPoint) {
            guard canvas.bounds.contains(point) else { return }
            let revision = parent.board.isRemoved ? parent.board.before ?? parent.model.review?.before : parent.board.after ?? parent.model.review?.after
            if let revision { parent.model.drop(board: parent.board.file, width: parent.preview.metadata.width, revision: revision, point: point) }
        }
        @objc func doubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scroll, !parent.model.pinTool, !parent.model.drawing, !parent.board.isPhone else { return }
            if scroll.zoomScale > scroll.minimumZoomScale + 0.01 { scroll.setZoomScale(scroll.minimumZoomScale, animated: !parent.reduceMotion) }
            else {
                let point = gesture.location(in: canvas); scroll.setZoomScale(1, animated: false)
                pan(to: CGPoint(x: point.x - scroll.bounds.width / 2, y: point.y - scroll.bounds.height / 2))
            }
        }
        @objc func tap(_ gesture: UITapGestureRecognizer) {
            guard parent.active, !parent.model.drawing else { return }
            let point = gesture.location(in: canvas)
            guard canvas.bounds.contains(point) else { return }
            let before = parent.model.peeking || parent.board.isRemoved || (parent.model.amount < 0.5 && parent.model.comparisonMode == "onion") || (parent.model.comparisonMode == "slider" && point.x < ((scroll?.contentOffset.x ?? 0) + (scroll?.bounds.width ?? 0) * (1 - parent.model.amount)) / (scroll?.zoomScale ?? 1))
            let revision = before ? parent.board.before ?? parent.model.review?.before : parent.board.after ?? parent.model.review?.after
            if parent.model.pinTool && !parent.model.comparing { drop(at: point) }
            else if parent.model.showChanges, let pin = parent.model.pins.first(where: {
                $0.board == parent.board.file && $0.noteId == nil && $0.width == parent.preview.metadata.width && $0.revision == revision && hypot($0.x - point.x, $0.y - point.y) < 24 / (scroll?.zoomScale ?? 1)
            }) { parent.model.edit(pin) }
            else { parent.model.selectedPin = nil }
        }
        func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
            guard parent.active else { return false }
            if gestureRecognizer is UIPanGestureRecognizer { return parent.model.comparing || parent.model.drawing || parent.model.areaTool }
            if gestureRecognizer is UILongPressGestureRecognizer { return !parent.model.comparing && !parent.model.drawing }
            return !parent.model.drawing
        }
        func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { false }
    }
}

private final class ReviewScrollView: UIScrollView {
    var didLayout: (() -> Void)?
    var adjustDivider: ((Double) -> Void)?
    var modeLocked = false
    var passPaging = true
    override var canBecomeFirstResponder: Bool { true }
    override var keyCommands: [UIKeyCommand]? {
        [UIKeyCommand(input: UIKeyCommand.inputLeftArrow, modifierFlags: [], action: #selector(left)),
         UIKeyCommand(input: UIKeyCommand.inputRightArrow, modifierFlags: [], action: #selector(right))]
    }
    @objc private func left() { adjustDivider?(-0.05) }
    @objc private func right() { adjustDivider?(0.05) }
    override func layoutSubviews() { super.layoutSubviews(); didLayout?() }
    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer, passPaging && !modeLocked {
            let velocity = panGestureRecognizer.velocity(in: self)
            if abs(velocity.x) > abs(velocity.y) { return false }
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
/// A preview still being drawn: the design system's shimmer at the tile's size.
struct V2ReviewShimmer: View {
    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shimmer = false
    var body: some View {
        GeometryReader { geometry in
            Rectangle().fill(WorkspaceStyle.hover(scheme)).overlay {
                if !reduceMotion {
                    LinearGradient(colors: [.clear, WorkspaceStyle.surface(scheme), .clear], startPoint: .leading, endPoint: .trailing)
                        .offset(x: shimmer ? geometry.size.width : -geometry.size.width)
                        .animation(WorkspaceStyle.Motion.shimmer(reduceMotion: reduceMotion), value: shimmer)
                }
            }.clipped()
        }.onAppear { shimmer = !reduceMotion }
    }
}
/// Says what is loading; after 10 s, how many screens are still being drawn.
struct V2ReviewLoadingLine: View {
    let total: Int
    let loaded: Int
    @State private var slow = false
    var body: some View {
        Group {
            if slow && loaded < total {
                Label("Still drawing \(total - loaded) of \(V2ReviewModel.count(total, "screen")). The first look at a design takes longer.", systemImage: "hourglass")
            } else { Text("Loading \(V2ReviewModel.count(total, "screen"))…") }
        }.font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            .task { try? await Task.sleep(for: .seconds(10)); slow = true }
    }
}
#endif
