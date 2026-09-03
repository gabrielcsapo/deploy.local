import { initializeSuitcaseMembershipState } from './suitcase-bootstrap.ts';

initializeSuitcaseMembershipState({
  membershipFile: process.env.DEPLOY_SUITCASE_MEMBERSHIP_FILE,
  pairingExchangeFile: process.env.DEPLOY_SUITCASE_MEMBERSHIP_BOOTSTRAP_FILE,
});
