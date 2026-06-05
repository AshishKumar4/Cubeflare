import type { ServerSummary } from '../types';

export type LifecycleAlarmInput = {
  hasManifest: boolean;
  containerRunning: boolean;
  status: ServerSummary['status'];
  activeBridgeConnections: number;
};

export type LifecycleAlarmDecision = {
  inspectRuntime: boolean;
  runBackup: boolean;
};

export function planLifecycleAlarm(input: LifecycleAlarmInput): LifecycleAlarmDecision {
  const serverShouldRun = input.status === 'running' || input.status === 'starting';
  const hasActiveBridgeConnections = input.activeBridgeConnections > 0;
  return {
    inspectRuntime: input.hasManifest && input.containerRunning && serverShouldRun && hasActiveBridgeConnections,
    runBackup: input.hasManifest && input.containerRunning && serverShouldRun && hasActiveBridgeConnections
  };
}

export function shouldRenewContainerActivity(activeBridgeConnections: number): boolean {
  return activeBridgeConnections > 0;
}
