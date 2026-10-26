import Foundation
import Testing
@testable import DeployCore

@Test func repositoryCloneUsesAdvertisedPathsAndPort() throws {
    let info = try JSONDecoder().decode(RepositoryInfo.self, from: Data(#"{"status":"ready","clonePath":"/git/owner/project.git","sshClonePath":"/owner/project.git","sshPort":2222}"#.utf8))
    #expect(info.cloneURL(origin: "https://deploy.local:8443")?.absoluteString == "https://deploy.local:8443/git/owner/project.git")
    #expect(info.cloneURL(origin: "https://deploy.local:8443", ssh: true)?.absoluteString == "ssh://git@deploy.local:2222/owner/project.git")
    #expect(info.cloneURL(origin: "https://user:secret@deploy.local") == nil)
}

@Test func repositoryCloneHandlesServersWithoutSSH() throws {
    let info = try JSONDecoder().decode(RepositoryInfo.self, from: Data(#"{"status":"ready","clonePath":"/git/project.git"}"#.utf8))
    #expect(info.cloneURL(origin: "https://deploy.local", ssh: true) == nil)
    #expect(info.cloneURL(origin: "https://deploy.local") != nil)
    let unsafe = try JSONDecoder().decode(RepositoryInfo.self, from: Data(#"{"status":"ready","clonePath":"//other.local/repo.git"}"#.utf8))
    #expect(unsafe.cloneURL(origin: "https://deploy.local") == nil)
}
