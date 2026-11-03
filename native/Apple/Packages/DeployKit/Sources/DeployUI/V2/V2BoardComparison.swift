#if os(iOS)
import SwiftUI
import UIKit
import DeployCore

/// Shared by the review, its chat card and the full board. AppStorage shares the choice on device.
struct V2BoardComparison: View {
    @Bindable var store: V2Store
    let project: String
    let board: V2DesignReview.Board
    let review: V2DesignReview
    let width: Int
    var height: CGFloat = 240
    var caption = true
    var open: (() -> Void)?
    @AppStorage(V2DesignComparison.modeKey) private var mode = "slider"
    @State private var percent = 50.0
    @State private var opacity = 40.0
    @State private var before: UIImage?
    @State private var after: UIImage?
    @State private var failed = false
    @Environment(\.colorScheme) private var scheme
    private var single: Bool { board.added || board.isRemoved }
    private var onion: Bool { mode == "onion" }

    var body: some View {
        VStack(spacing: 6) {
            if !single {
                Picker("Comparison mode", selection: $mode) {
                    Text("Slider").tag("slider")
                    Text("Onion skin").tag("onion")
                }.pickerStyle(.segmented).frame(width: 200, height: 44)
            } else {
                Text(board.isRemoved ? "Removed" : "New board")
                    .font(.system(size: 12)).foregroundStyle(WorkspaceStyle.secondary(scheme))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(WorkspaceStyle.sidebar(scheme), in: Capsule())
            }
            Group {
                if failed {
                    Text("Couldn’t draw this board").font(.system(size: 13)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
                } else if let image = before ?? after {
                    GeometryReader { proxy in
                        // Use one scale and origin, including when the two renders have different heights.
                        let ratio = max(before.map { $0.size.height / $0.size.width } ?? 0,
                                        after.map { $0.size.height / $0.size.width } ?? 0)
                        let w = min(proxy.size.width, proxy.size.height / ratio)
                        let h = w * ratio
                        ZStack(alignment: .topLeading) {
                            ZStack(alignment: .topLeading) {
                                rendered(before ?? image, width: w)
                                if !single, let after {
                                    rendered(after, width: w)
                                        .opacity(onion ? opacity / 100 : 1)
                                        .mask(alignment: .trailing) {
                                            Rectangle().frame(width: onion ? w : w * percent / 100, height: h)
                                        }
                                }
                            }
                            .frame(width: w, height: h, alignment: .topLeading)
                            .background(WorkspaceStyle.canvas(scheme))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(WorkspaceStyle.line(scheme)))
                            .contentShape(Rectangle())
                            .onTapGesture { open?() }
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel(board.name)
                            .accessibilityAction { open?() }
                            if !single && !onion {
                                HStack {
                                    corner("Before")
                                    Spacer()
                                    corner("After")
                                }.padding(8).allowsHitTesting(false).accessibilityHidden(true)
                                handle(width: w, height: h)
                            }
                        }
                        .frame(width: w, height: h)
                        .coordinateSpace(name: "comparison")
                        .frame(width: proxy.size.width, height: proxy.size.height)
                    }
                } else { ProgressView() }
            }.frame(height: height).frame(maxWidth: .infinity)
            if single {
                Text(board.isRemoved ? "Before" : "After only · no previous version")
                    .font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
            } else if onion {
                VStack(spacing: 0) {
                    HStack { Text("After opacity"); Spacer(); Text("\(Int(opacity))%") }
                    Slider(value: $opacity, in: 0...100, step: 1) { Text("After opacity") }
                        .tint(WorkspaceStyle.text(scheme))
                        .accessibilityValue("\(Int(opacity))% After")
                        .accessibilityAdjustableAction { direction in
                            switch direction {
                            case .increment: opacity = V2DesignComparison.percent(opacity + 1)
                            case .decrement: opacity = V2DesignComparison.percent(opacity - 1)
                            @unknown default: break
                            }
                        }
                        .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow, .home, .end]) { press in
                            switch press.key {
                            case .rightArrow, .upArrow: opacity = V2DesignComparison.percent(opacity + 1)
                            case .leftArrow, .downArrow: opacity = V2DesignComparison.percent(opacity - 1)
                            case .home: opacity = 0
                            case .end: opacity = 100
                            default: return .ignored
                            }
                            return .handled
                        }
                    HStack { Text("0% Before"); Spacer(); Text("100% After") }
                        .foregroundStyle(WorkspaceStyle.tertiary(scheme))
                }.font(.system(size: 12)).padding(.horizontal, 12)
            } else if caption {
                Text("\(board.name) · \(width) px · drag to compare")
                    .font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
            }
        }
        .task(id: "\(project)/\(board.file)/\(review.before)/\(review.after)/\(width)") { await load() }
    }

    private func rendered(_ image: UIImage, width: CGFloat) -> some View {
        Image(uiImage: image).resizable()
            .frame(width: width, height: width * image.size.height / image.size.width)
            .accessibilityHidden(true)
    }
    private func corner(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).foregroundStyle(WorkspaceStyle.secondary(scheme))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 8))
    }
    private func handle(width: CGFloat, height: CGFloat) -> some View {
        ZStack {
            Rectangle().fill(WorkspaceStyle.text(scheme)).frame(width: 2)
                .overlay(Rectangle().stroke(WorkspaceStyle.surface(scheme), lineWidth: 1))
            HStack(spacing: 6) {
                Image(systemName: "chevron.left")
                Image(systemName: "chevron.right")
            }.font(.system(size: 13, weight: .medium))
                .frame(width: 44, height: 44)
                .background(WorkspaceStyle.surface(scheme), in: Circle())
                .overlay(Circle().stroke(WorkspaceStyle.line(scheme)))
        }
        .foregroundStyle(WorkspaceStyle.text(scheme))
        .frame(width: 44, height: height).contentShape(Rectangle())
        .highPriorityGesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("comparison"))
            .onChanged { value in percent = V2DesignComparison.after(at: value.location.x, width: width) })
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Compare").accessibilityValue("\(Int(percent))% After")
        .accessibilityAdjustableAction { direction in
            switch direction {
            case .increment: percent = V2DesignComparison.percent(percent + 1)
            case .decrement: percent = V2DesignComparison.percent(percent - 1)
            @unknown default: break
            }
        }
        .focusable()
        .onKeyPress(keys: [.leftArrow, .rightArrow, .upArrow, .downArrow, .home, .end]) { press in
            switch press.key {
            case .leftArrow, .upArrow: percent = V2DesignComparison.percent(percent + 1)
            case .rightArrow, .downArrow: percent = V2DesignComparison.percent(percent - 1)
            case .home: percent = 0
            case .end: percent = 100
            default: return .ignored
            }
            return .handled
        }
        .position(x: width * (1 - percent / 100), y: height / 2)
    }

    private func load() async {
        before = nil; after = nil; failed = false
        let client = store.client
        do {
            if board.isRemoved {
                let data = try await client.designImage(project: project, board: board.file, commit: review.before, width: width)
                try Task.checkCancellation()
                before = UIImage(data: data); failed = before == nil
            } else if board.added {
                let data = try await client.designImage(project: project, board: board.file, commit: review.after, width: width)
                try Task.checkCancellation()
                after = UIImage(data: data); failed = after == nil
            } else {
                let projectID = project, file = board.file, renderWidth = width
                let beforeCommit = review.before, afterCommit = review.after
                async let old = client.designImage(project: projectID, board: file, commit: beforeCommit, width: renderWidth)
                async let new = client.designImage(project: projectID, board: file, commit: afterCommit, width: renderWidth)
                let images = try await (old, new)
                try Task.checkCancellation()
                before = UIImage(data: images.0); after = UIImage(data: images.1)
                failed = before == nil || after == nil
            }
        } catch {
            if !Task.isCancelled { failed = true }
        }
    }
}

/// Added and removed boards have no comparison controls, as in the review's compact row.
struct V2SingleBoardRow: View {
    @Bindable var store: V2Store
    let project: String
    let board: V2DesignReview.Board
    let review: V2DesignReview
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        HStack(spacing: 12) {
            V2BoardImage(store: store, project: project, board: board.file,
                         commit: board.isRemoved ? review.before : review.after, width: board.isPhone ? 390 : 700)
                .frame(width: 58, height: 72)
            VStack(alignment: .leading, spacing: 4) {
                Text(board.title).font(.system(size: 17, weight: .medium))
                Text(board.isRemoved ? "Removed" : "New board").font(.system(size: 12))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(WorkspaceStyle.sidebar(scheme), in: Capsule())
                Text(board.isRemoved ? "Before" : "After only · no previous version")
                    .font(.system(size: 12)).foregroundStyle(WorkspaceStyle.tertiary(scheme))
            }
            Spacer(minLength: 0)
        }.padding(.horizontal, 12).padding(.vertical, 10)
            .background(WorkspaceStyle.surface(scheme), in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(WorkspaceStyle.line(scheme)))
    }
}
#endif
