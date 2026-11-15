import Foundation
import Testing
@testable import DeployCore

struct V2ArtifactsTests {
    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }
    private let now = ISO8601DateFormatter().date(from: "2026-11-14T12:00:00Z")!

    @Test func galleryDecodesAndGroupsByProject() throws {
        let json = #"{"artifacts":[{"projectId":"deploy-local","project":"deploy.local","artifact":null,"kind":"design","name":"App design","boards":171,"updatedAt":"2026-11-14T09:00:00Z","branch":null,"state":"review"},{"projectId":"forma","project":"forma","artifact":"podcasts-page","kind":"design","name":"Podcasts page","boards":6,"updatedAt":"2026-11-13T09:00:00Z","branch":"artifact/podcasts-page","state":"unproposed"},{"projectId":"deploy-local","project":"deploy.local","artifact":"one-server-plan","kind":"document","name":"One server plan","updatedAt":"2026-11-11T09:00:00Z","branch":null,"state":null},{"projectId":"home-gym","project":"home-gym","artifact":"workout-plan-import","kind":"document","name":"Workout plan import","updatedAt":"2026-10-12T09:00:00Z","branch":null,"state":null}],"projects":[{"id":"deploy-local","name":"deploy.local"},{"id":"forma","name":"forma"},{"id":"home-gym","name":"home-gym"},{"id":"tally","name":"tally"}]}"#
        let gallery = try JSONDecoder().decode(V2ArtifactGallery.self, from: Data(json.utf8))
        #expect(gallery.summary == "4 artifacts · 1 in review")
        #expect(gallery.byProject.map(\.project.name) == ["deploy.local", "forma", "home-gym"])
        let subtitles = gallery.artifacts.map { $0.subtitle(now: now, calendar: calendar) }
        #expect(subtitles == ["171 boards · in review", "6 boards · not proposed", "Document · 3 days ago", "Document · 12 October"])
    }

    @Test func emptyGallerySaysNoneYet() throws {
        let gallery = try JSONDecoder().decode(V2ArtifactGallery.self, from: Data(#"{"artifacts":[],"projects":[]}"#.utf8))
        #expect(gallery.summary == "None yet")
        #expect(gallery.byProject.isEmpty)
    }

    @Test func aNameBecomesItsFolderAndTheSheetSaysWhere() {
        #expect(V2Artifacts.slug("Onboarding flow") == "onboarding-flow")
        #expect(V2Artifacts.slug("  Café — Plan!  ") == "cafe-plan")
        #expect(V2Artifacts.slug("!!!") == "")
        #expect(V2Artifacts.createNote(name: "Onboarding flow", project: "forma") == "deploy.local adds artifacts/onboarding-flow to forma on a new branch, artifact/onboarding-flow. It reaches main when you approve it.")
        #expect(V2Artifacts.createNote(name: " ", project: "forma") == "")
    }

    @Test func aDocumentReadsAsBlocks() throws {
        let json = ##"{"projectId":"deploy-local","project":"deploy.local","artifact":"one-server-plan","title":"One server plan","text":"# One server plan\n\ndeploy.local runs as one server process.\n\n## What moves\n\n- The event service moves.\n- Timers start at boot.\n\n1. First\n2. Second\n\n```\npnpm test\n```\n","main":"# One server plan\n","branch":null,"commit":"abc","edits":0,"changedAt":"2026-11-11T09:00:00Z","review":null}"##
        let document = try JSONDecoder().decode(V2ArtifactDocument.self, from: Data(json.utf8))
        #expect(document.meta(now: now, calendar: calendar) == "deploy.local · on main · changed 3 days ago")
        #expect(document.blocks == [
            .paragraph("deploy.local runs as one server process."),
            .heading("What moves"),
            .bullet("The event service moves."),
            .bullet("Timers start at boot."),
            .number(1, "First"),
            .number(2, "Second"),
            .code("pnpm test"),
        ])
    }

    @Test func whenInWords() {
        let at = { (days: Double) in ISO8601DateFormatter().string(from: self.now.addingTimeInterval(-days * 86_400)) }
        #expect(V2Artifacts.changedWhen(at(0), now: now, calendar: calendar) == "today")
        #expect(V2Artifacts.changedWhen(at(1), now: now, calendar: calendar) == "yesterday")
        #expect(V2Artifacts.changedWhen(at(3), now: now, calendar: calendar) == "3 days ago")
        #expect(V2Artifacts.changedWhen(at(5), now: now, calendar: calendar) == "Monday")
        #expect(V2Artifacts.changedWhen(nil, now: now, calendar: calendar) == "")
    }

    @Test func aDocumentNotOnMainSaysSo() throws {
        let json = ##"{"projectId":"p","project":"deploy.local","artifact":"plan","title":"Plan","text":"# Plan\n","main":null,"branch":"artifact/plan","commit":"abc","edits":0,"changedAt":"2026-11-14T09:00:00Z","review":null}"##
        let document = try JSONDecoder().decode(V2ArtifactDocument.self, from: Data(json.utf8))
        #expect(document.meta(now: now, calendar: calendar) == "deploy.local · not on main yet · changed today")
    }

    @Test func aReviewMarksWhatDiffersOnEachSide() throws {
        let json = ##"{"projectId":"p","project":"deploy.local","artifact":"plan","title":"Plan","text":"# Plan\n\nOne.\n\n- Keep\n- Added\n\nNew order.\n","main":"# Plan\n\nOne.\n\n- Keep\n\nOld order.\n","branch":"artifact/plan","commit":"abc","edits":0,"changedAt":"2026-11-11T09:00:00Z","review":{"id":"design:p:artifact~plan:abc","branch":"artifact/plan","state":"waiting"}}"##
        let document = try JSONDecoder().decode(V2ArtifactDocument.self, from: Data(json.utf8))
        #expect(document.review?.id == "design:p:artifact~plan:abc")
        let after = V2DocumentReview(document: document, side: .after)
        #expect(after.marked == [false, false, true, true])
        #expect(after.progress == "2 blocks changed")
        #expect(V2DocumentReview.meta(document, side: .after, review: after) == "deploy.local · 2 blocks changed on this branch")
        let before = V2DocumentReview(document: document, side: .before)
        #expect(before.marked == [false, false, true])
        #expect(V2DocumentReview.meta(document, side: .before, review: before, now: now, calendar: calendar) == "deploy.local · on main · changed 3 days ago")
        var made = document
        made.main = nil
        let new = V2DocumentReview(document: made, side: .before)
        #expect(new.isNew && new.marked.allSatisfy { !$0 })
        #expect(new.progress == "new document")
        #expect(V2DocumentReview.meta(made, side: .after, review: new) == "deploy.local · not on main yet")
    }

    @Test func renumberingAListChangesNothing() {
        #expect(V2Artifacts.changed(before: [.number(1, "A"), .number(2, "B")], after: [.number(1, "B"), .number(2, "A")]) == [false, false])
    }

    @Test func aDocumentReviewNamesItsDocument() throws {
        let json = ##"{"id":"design:p:artifact~plan:abc","kind":"other","title":"Plan","text":"","from":"alice","createdAt":"2026-11-14T09:00:00Z","actions":[{"id":"approve","label":"Approve document","primary":true}],"state":"waiting","document":"plan"}"##
        let item = try JSONDecoder().decode(InboxItem.self, from: Data(json.utf8))
        #expect(item.document == "plan")
    }
}
