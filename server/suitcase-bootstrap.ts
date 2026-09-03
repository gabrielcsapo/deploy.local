import {
  bootstrapSuitcaseMembershipFile,
  clearPendingAdministratorProjection,
  readPendingAdministratorProjection,
  readSuitcaseMembership,
} from '../lib/suitcase-sync-client.ts';
import { applyAdministratorProjection } from './offline-auth.ts';
import { installDelegatedCertificateMaterial } from './certs.ts';
import { bootstrapSuitcaseFleet } from './suitcase-projector.ts';
import { installSiteIdentity } from './site-identity.ts';
import { ensureCoordinatorNode, getDefaultNodeId, setDefaultNode } from './store.ts';

export function initializeSuitcaseMembershipState(input: {
  membershipFile?: string;
  pairingExchangeFile?: string;
}): boolean {
  if (!input.membershipFile) return false;
  if (input.pairingExchangeFile) {
    bootstrapSuitcaseMembershipFile(input.membershipFile, input.pairingExchangeFile);
  }
  const membership = readSuitcaseMembership(undefined, input.membershipFile);
  if (!membership) return false;
  if (membership.tls) {
    installDelegatedCertificateMaterial({
      privateKey: membership.tls.privateKey,
      intermediateCertificate: membership.tls.intermediateCertificate,
      rootCertificate: membership.tls.rootCertificate,
    });
  }
  installSiteIdentity({
    siteId: membership.siteId,
    publicKey: membership.publicKey,
    privateKey: membership.privateKey,
    createdAt: membership.pairedAt,
  });
  bootstrapSuitcaseFleet({
    fleetId: membership.fleetId,
    homeSiteId: membership.homeSiteId,
    localSiteId: membership.siteId,
    localSiteName: membership.name,
    rootPublicIdentity: membership.siteKeys[membership.homeSiteId] || '',
    localPublicKey: membership.publicKey,
    siteKeys: membership.siteKeys,
    defaultDataPolicy: membership.defaultDataPolicy,
    accessMode: membership.accessMode,
    securityProfile: membership.securityProfile,
    siteCredential: membership.credential,
  });
  // The detached core is both the Suitcase control plane and its local execution target. A fresh
  // appliance must therefore be immediately deployable without asking an administrator to enroll
  // or select the machine it is already running on. Preserve an explicit existing selection when
  // re-running bootstrap so upgrades remain idempotent.
  ensureCoordinatorNode();
  if (!getDefaultNodeId()) setDefaultNode('coordinator');
  const projectionSource = input.pairingExchangeFile || input.membershipFile;
  const administratorProjection = readPendingAdministratorProjection(undefined, projectionSource);
  if (administratorProjection) {
    applyAdministratorProjection(administratorProjection, membership.siteId);
    clearPendingAdministratorProjection(undefined, projectionSource);
  }
  return true;
}
