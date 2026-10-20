import Testing
import Foundation
@testable import DeployCore

@Test func workerDecodesPermissionsAndTheirStepsOnTheComputer() throws {
    let source = """
    {"id":"ser","name":"ser","platform":"linux","architecture":"x64","status":"online","capabilities":["git"],
     "permissions":[
       {"id":"tasks","label":"Run coding tasks","state":"on","summary":"ser runs tasks.","step":{"where":"here","label":"Revoke","action":"revoke-worker"}},
       {"id":"screen","label":"See the screen","state":"needs-approval","summary":"Approve once.","step":{"where":"computer","label":"Approve","command":"deploy desktop-helper setup"}},
       {"id":"input","label":"Click and type","state":"off","summary":"View-only."}
     ]}
    """
    let worker = try JSONDecoder().decode(Worker.self, from: Data(source.utf8))
    let permissions = try #require(worker.permissions)
    #expect(permissions.map(\.id) == ["tasks", "screen", "input"])
    #expect(permissions[0].step?.onComputer == false)
    #expect(permissions[0].step?.action == "revoke-worker")
    #expect(permissions[1].step?.onComputer == true)
    #expect(permissions[1].step?.command == "deploy desktop-helper setup")
    #expect(permissions[1].badge == "Needs approval")
    #expect(permissions[2].step == nil)
    #expect(worker.permissionsHeadline == "1 of 3 allowed · 1 waiting for approval")
}

@Test func olderCoordinatorsWithoutPermissionsStillDecode() throws {
    let source = #"{"id":"ser","name":"ser","platform":"linux","architecture":"x64","status":"online","capabilities":["git"]}"#
    let worker = try JSONDecoder().decode(Worker.self, from: Data(source.utf8))
    #expect(worker.permissions == nil)
    #expect(worker.permissionsHeadline == nil)
}
