import type { ResourceDefinition } from '../apiserver';

export const PODDISRUPTIONBUDGETS: ResourceDefinition = {
  group: 'policy', version: 'v1', resource: 'poddisruptionbudgets',
  singular: 'poddisruptionbudget', kind: 'PodDisruptionBudget', namespaced: true,
  shortNames: ['pdb'], subresources: ['status'],
};

export const DISRUPTION_RESOURCES: ResourceDefinition[] = [PODDISRUPTIONBUDGETS];
