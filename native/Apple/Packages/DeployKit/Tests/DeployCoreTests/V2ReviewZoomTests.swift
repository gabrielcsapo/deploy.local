import Testing
@testable import DeployCore

struct V2ReviewZoomTests {
    @Test func aWebScreenZoomsOutUntilItsWholeWidthIsInView() {
        #expect(abs(V2ReviewZoom.fit(content: 1440, viewport: 390) - 390.0 / 1440.0) < 0.0001)
        #expect(abs(V2ReviewZoom.fit(content: 700, viewport: 390) - 390.0 / 700.0) < 0.0001)
    }

    @Test func aPhoneScreenStaysAtItsOwnSize() {
        #expect(V2ReviewZoom.fit(content: 390, viewport: 390) == 1)
        #expect(V2ReviewZoom.fit(content: 390, viewport: 430) == 1)
    }

    @Test func aScreenWithNoSizeYetDoesNotZoom() {
        #expect(V2ReviewZoom.fit(content: 0, viewport: 390) == 1)
        #expect(V2ReviewZoom.fit(content: 1440, viewport: 0) == 1)
    }

    @Test func aSwipePagesWhenFittedOrWhereTheScreenOpened() {
        // Fitted: nothing sideways to pan, so the swipe pages, even after scrolling down.
        #expect(V2ReviewZoom.passesPaging(zoom: 0.27, minimum: 0.27, whereItOpened: false))
        // A phone screen is fitted at its own size.
        #expect(V2ReviewZoom.passesPaging(zoom: 1, minimum: 1, whereItOpened: false))
        // A web screen at real size that has not been moved.
        #expect(V2ReviewZoom.passesPaging(zoom: 1, minimum: 0.27, whereItOpened: true))
        // Moved or zoomed in: the swipe pans the screen instead.
        #expect(!V2ReviewZoom.passesPaging(zoom: 1, minimum: 0.27, whereItOpened: false))
        #expect(!V2ReviewZoom.passesPaging(zoom: 2, minimum: 0.27, whereItOpened: false))
    }

    @Test func aFittedScreenStaysFittedWhenTheWindowTurns() {
        let portrait = V2ReviewZoom.fit(content: 1440, viewport: 390)
        let landscape = V2ReviewZoom.fit(content: 1440, viewport: 844)
        #expect(V2ReviewZoom.afterResize(zoom: portrait, oldMinimum: portrait, newMinimum: landscape) == landscape)
        #expect(V2ReviewZoom.afterResize(zoom: landscape, oldMinimum: landscape, newMinimum: portrait) == portrait)
        // At real size it stays at real size.
        #expect(V2ReviewZoom.afterResize(zoom: 1, oldMinimum: portrait, newMinimum: landscape) == 1)
        // Zoomed below what the new window allows: raised to it.
        #expect(V2ReviewZoom.afterResize(zoom: 0.4, oldMinimum: portrait, newMinimum: landscape) == landscape)
        // A phone screen never changes.
        #expect(V2ReviewZoom.afterResize(zoom: 1, oldMinimum: 1, newMinimum: 1) == 1)
    }

    @Test func aSmallScreenSitsInTheMiddle() {
        #expect(V2ReviewZoom.centred(content: 244, viewport: 600) == 178)
        #expect(V2ReviewZoom.centred(content: 900, viewport: 600) == 0)
    }
}
