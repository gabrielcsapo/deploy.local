import XCTest
@testable import DeployCore

final class InteractionLayoutTests: XCTestCase {
    func testSplitWidthMigrationRetainsDeviceWidthAndBoundsInvalidPreferences() {
        XCTAssertEqual(InteractionLayout.splitWidth(555), 555)
        XCTAssertEqual(InteractionLayout.splitWidth(1), 320)
        XCTAssertEqual(InteractionLayout.splitWidth(1000), 720)
        XCTAssertEqual(InteractionLayout.splitWidth(.nan), 400)
    }
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
    func testTrailingPanelStaysInsideThePaneAndKeepsItsArrowOnTheButton() {
        // The repository hub's Clone button sits near the trailing edge of its pane.
        for pane in stride(from: 420.0, through: 1600.0, by: 20.0) {
            let button = (x: pane - 160, width: 68.0)
            let panel = InteractionLayout.trailingPanel(pane: pane, buttonX: button.x, buttonWidth: button.width)
            let centre = button.x + button.width / 2 + panel.offset
            XCTAssertLessThanOrEqual(centre + panel.width / 2, pane - 12 + 0.001, "trailing edge at pane \(pane)")
            XCTAssertGreaterThanOrEqual(centre - panel.width / 2, 12 - 0.001, "leading edge at pane \(pane)")
            XCTAssertLessThanOrEqual(panel.width, 400)
            XCTAssertGreaterThanOrEqual(panel.width, 280)
            // The arrow points at the anchor's centre, which never leaves the button.
            XCTAssertGreaterThanOrEqual(centre, button.x)
            XCTAssertLessThanOrEqual(centre, button.x + button.width)
        }
        // A button with room to spare keeps the ideal width and no slide at all.
        let roomy = InteractionLayout.trailingPanel(pane: 1200, buttonX: 400, buttonWidth: 68)
        XCTAssertEqual(roomy.width, 400)
        XCTAssertEqual(roomy.offset, 0)
        // A narrow pane holds a narrower panel, down to the readable minimum.
        XCTAssertEqual(InteractionLayout.trailingPanel(pane: 420, buttonX: 260, buttonWidth: 68).width, 296)
        XCTAssertEqual(InteractionLayout.trailingPanel(pane: 320, buttonX: 200, buttonWidth: 68).width, 280)
        // Unmeasured geometry keeps the ideal panel rather than collapsing it.
        XCTAssertEqual(InteractionLayout.trailingPanel(pane: 0, buttonX: 0, buttonWidth: 0).width, 400)
        XCTAssertEqual(InteractionLayout.trailingPanel(pane: .nan, buttonX: 10, buttonWidth: 68).width, 400)
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
