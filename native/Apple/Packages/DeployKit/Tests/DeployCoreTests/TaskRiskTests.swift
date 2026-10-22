import Testing
import Foundation
@testable import DeployCore

@Test func riskChipsRequireReadyRolesAndInputPermission() throws {
    func computer(deploy: String = "ready", screen: String = "ready", online: Bool = true) throws -> Computer {
        let json = """
        {"id":"computer","name":"Computer","platform":"darwin","online":\(online),"workerIds":["worker"],"roles":{"deploy":{"state":"\(deploy)","reason":""},"computer":{"state":"\(screen)","reason":""}}}
        """
        return try JSONDecoder().decode(Computer.self, from: Data(json.utf8))
    }
    let input = try JSONDecoder().decode(NodePermission.self, from: Data(#"{"id":"input","label":"Input","state":"on","summary":"Allowed"}"#.utf8))
    #expect(try TaskRisk.forComputer(computer(), permissions: [input]).map(\.label) == ["Can deploy", "Screen access"])
    #expect(try TaskRisk.forComputer(computer(), permissions: []).map(\.label) == ["Can deploy"])
    #expect(try TaskRisk.forComputer(computer(online: false), permissions: [input]).isEmpty)
    #expect(TaskRisk.forComputer(nil, permissions: [input]).isEmpty)
    for state in ["off", "paused", "needs-setup"] {
        #expect(try TaskRisk.forComputer(computer(deploy: state, screen: state), permissions: [input]).isEmpty)
    }
}
