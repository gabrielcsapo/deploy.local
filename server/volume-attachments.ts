import type { ApplicationSpec } from './application-spec.ts';
import type { RuntimeAdmissionFinding } from './component-profiles.ts';

export interface VolumeAttachment {
  resource: string;
  consistencyGroup: string;
  ownership: ApplicationSpec['resources'][string]['ownership'];
  backup: ApplicationSpec['resources'][string]['backup'];
  suitcase: ApplicationSpec['resources'][string]['suitcase'];
  component: string;
  mountPaths: readonly string[];
  readOnly: boolean;
  desiredInstances: number;
}

export interface VolumeAttachmentPlan {
  attachments: readonly VolumeAttachment[];
  findings: readonly RuntimeAdmissionFinding[];
  blocked: boolean;
}

export interface VolumeAttachmentCapabilities {
  /** Resources whose backing provider was positively proven safe for concurrent writers. */
  sharedWriterResources?: ReadonlySet<string>;
  /** Site-local fixed counts after manifest override admission. */
  desiredInstances?: Readonly<Record<string, number>>;
}

/**
 * Validate declared access semantics against desired component instances.
 * Attachments are grouped per component/resource so mounting one volume at two paths does not
 * invent a second writer, while two desired component instances correctly count as two writers.
 */
export function planVolumeAttachments(
  spec: ApplicationSpec,
  capabilities: VolumeAttachmentCapabilities = {},
): VolumeAttachmentPlan {
  const grouped = new Map<
    string,
    { resource: string; component: string; paths: string[]; readOnly: boolean; instances: number }
  >();
  const findings: RuntimeAdmissionFinding[] = [];

  for (const [componentName, component] of Object.entries(spec.components)) {
    for (const [mountPath, mount] of Object.entries(component.mounts)) {
      const resource = spec.resources[mount.resource];
      if (!resource) {
        findings.push({
          code: 'VOLUME_RESOURCE_UNKNOWN',
          severity: 'error',
          path: `/components/${componentName}/mounts/${escapePointer(mountPath)}`,
          message: `Mount references unknown volume resource ${JSON.stringify(mount.resource)}`,
        });
        continue;
      }
      const key = `${componentName}\u0000${mount.resource}`;
      const current = grouped.get(key);
      if (current) {
        current.paths.push(mountPath);
        // Any writable mount makes the component instance a writer.
        current.readOnly = current.readOnly && mount.readOnly;
      } else {
        grouped.set(key, {
          resource: mount.resource,
          component: componentName,
          paths: [mountPath],
          readOnly: mount.readOnly,
          instances: capabilities.desiredInstances?.[componentName] ?? component.instances,
        });
      }
    }
  }

  const attachments: VolumeAttachment[] = [...grouped.values()]
    .sort(
      (left, right) =>
        left.resource.localeCompare(right.resource) ||
        left.component.localeCompare(right.component),
    )
    .map((item) => ({
      resource: item.resource,
      consistencyGroup: spec.resources[item.resource].consistencyGroup,
      ownership: spec.resources[item.resource].ownership,
      backup: spec.resources[item.resource].backup,
      suitcase: spec.resources[item.resource].suitcase,
      component: item.component,
      mountPaths: item.paths.sort(),
      readOnly: item.readOnly,
      desiredInstances: item.instances,
    }));

  for (const [resourceName, resource] of Object.entries(spec.resources)) {
    const resourceAttachments = attachments.filter((item) => item.resource === resourceName);
    const writerSlots = resourceAttachments
      .filter((item) => !item.readOnly)
      .reduce((total, item) => total + item.desiredInstances, 0);

    if (resource.access === 'multipleReaders' && writerSlots > 0) {
      findings.push({
        code: 'READ_ONLY_VOLUME_HAS_WRITER',
        severity: 'error',
        path: `/resources/${resourceName}/access`,
        message: `Volume ${JSON.stringify(resourceName)} is multipleReaders but has ${writerSlots} desired writable attachment${writerSlots === 1 ? '' : 's'}`,
      });
    }
    if (resource.access === 'singleWriter' && writerSlots > 1) {
      findings.push({
        code: 'SINGLE_WRITER_VOLUME_HAS_MULTIPLE_WRITERS',
        severity: 'error',
        path: `/resources/${resourceName}/access`,
        message: `Volume ${JSON.stringify(resourceName)} is singleWriter but the desired graph creates ${writerSlots} writers`,
      });
    }
    if (
      resource.access === 'sharedWriters' &&
      writerSlots > 1 &&
      !capabilities.sharedWriterResources?.has(resourceName)
    ) {
      findings.push({
        code: 'SHARED_WRITER_PROVIDER_UNPROVEN',
        severity: 'error',
        path: `/resources/${resourceName}/access`,
        message: `Volume ${JSON.stringify(resourceName)} requests sharedWriters, but its provider has not proven concurrent-writer safety`,
      });
    }
  }

  return {
    attachments,
    findings,
    blocked: findings.some((item) => item.severity === 'error'),
  };
}

function escapePointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}
