import { assertCiMutation } from '../ci-fence.ts';
import { getDb } from './connection.ts';
import { applicationConfigurationValues } from '../schema.ts';
import { and, eq } from 'drizzle-orm';

export interface ApplicationConfigurationValueInput {
  deploymentName: string;
  specDigest: string;
  key: string;
  siteId?: string;
  valueType: string;
  value: string;
  valueDigest: string;
  updatedBy: string;
}

export function setApplicationConfigurationValue(input: ApplicationConfigurationValueInput) {
  assertCiMutation(input.deploymentName);
  const db = getDb();
  const siteId = input.siteId || '';
  const existing = db
    .select({ revision: applicationConfigurationValues.revision })
    .from(applicationConfigurationValues)
    .where(
      and(
        eq(applicationConfigurationValues.deploymentName, input.deploymentName),
        eq(applicationConfigurationValues.specDigest, input.specDigest),
        eq(applicationConfigurationValues.key, input.key),
        eq(applicationConfigurationValues.siteId, siteId),
      ),
    )
    .get();
  const revision = (existing?.revision || 0) + 1;
  db.insert(applicationConfigurationValues)
    .values({
      deploymentName: input.deploymentName,
      specDigest: input.specDigest,
      key: input.key,
      siteId,
      valueType: input.valueType,
      value: input.value,
      valueDigest: input.valueDigest,
      revision,
      updatedBy: input.updatedBy,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: [
        applicationConfigurationValues.deploymentName,
        applicationConfigurationValues.specDigest,
        applicationConfigurationValues.key,
        applicationConfigurationValues.siteId,
      ],
      set: {
        valueType: input.valueType,
        value: input.value,
        valueDigest: input.valueDigest,
        revision,
        updatedBy: input.updatedBy,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
  return revision;
}

export function getApplicationConfigurationValues(
  deploymentName: string,
  specDigest: string,
  siteId = '',
) {
  return getDb()
    .select()
    .from(applicationConfigurationValues)
    .where(
      and(
        eq(applicationConfigurationValues.deploymentName, deploymentName),
        eq(applicationConfigurationValues.specDigest, specDigest),
        eq(applicationConfigurationValues.siteId, siteId),
      ),
    )
    .all();
}

export function getAllApplicationConfigurationValues(deploymentName: string, specDigest: string) {
  return getDb()
    .select()
    .from(applicationConfigurationValues)
    .where(
      and(
        eq(applicationConfigurationValues.deploymentName, deploymentName),
        eq(applicationConfigurationValues.specDigest, specDigest),
      ),
    )
    .all();
}
