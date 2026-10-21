import XCTest
@testable import DeployCore

final class InteractionLayoutTests: XCTestCase {
    func testLegacyActivityPreference() {
        XCTAssertEqual(InteractionLayout.activityMode("collapsed"), "closed")
        XCTAssertEqual(InteractionLayout.activityMode("open"), "open")
        XCTAssertEqual(InteractionLayout.activityMode("invalid"), "closed")
    }
    func testCardMargin() {
        XCTAssertNil(InteractionLayout.taskCardWidth(pane: 1199, reading: 720))
        XCTAssertEqual(InteractionLayout.taskCardWidth(pane: 1200, reading: 720), 216)
        XCTAssertEqual(InteractionLayout.taskCardWidth(pane: 1324, reading: 720), 260)
        XCTAssertEqual(InteractionLayout.taskCardWidth(pane: 2000, reading: 720), 260)
    }
    func testOneSelectionForVisibleProjectTasks() {
        XCTAssertFalse(InteractionLayout.taskHasProjectSelection(index: 0, expanded: false, searching: false, showAll: false))
        XCTAssertTrue(InteractionLayout.taskHasProjectSelection(index: 0, expanded: true, searching: false, showAll: false))
        XCTAssertFalse(InteractionLayout.taskHasProjectSelection(index: 7, expanded: true, searching: false, showAll: false))
        XCTAssertTrue(InteractionLayout.taskHasProjectSelection(index: 7, expanded: true, searching: false, showAll: true))
        XCTAssertTrue(InteractionLayout.taskHasProjectSelection(index: 7, expanded: false, searching: true, showAll: false))
        XCTAssertFalse(InteractionLayout.taskHasProjectSelection(index: nil, expanded: true, searching: true, showAll: true))
    }
    func testComposerStatus() {
        for card in [false, true] {
            for mode in ["open", "closed"] {
                XCTAssertEqual(InteractionLayout.composerActivityVisible(card: card, mode: mode, running: 1, failing: 0), !card && mode == "closed")
                XCTAssertEqual(InteractionLayout.composerActivityVisible(card: card, mode: mode, running: 0, failing: 1), !card && mode == "closed")
                XCTAssertFalse(InteractionLayout.composerActivityVisible(card: card, mode: mode, running: 0, failing: 0))
            }
        }
    }
}
