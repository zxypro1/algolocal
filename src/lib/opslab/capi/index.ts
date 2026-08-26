/**
 * 机器也是声明出来的
 *
 * Cluster API 把「加一台机器」变成「改一个副本数」。形状和工作负载那一套
 * 完全对应，而多出来的那件事是**时间**：机器不是立刻就有的。
 */
export {
  CLUSTERS, MACHINEDEPLOYMENTS, MACHINESETS, MACHINES, VSPHEREMACHINETEMPLATES,
  CAPI_RESOURCES, CAPI_LABEL, MACHINE_SET_LABEL, MACHINE_DEPLOYMENT_LABEL,
} from './resources';
export {
  MachineDeploymentController, MachineSetController, MachineController,
  PROVISION_MS, BOOTSTRAP_MS,
} from './controller';
export type { CapiOptions } from './controller';
