import type { PipelineStage } from '../types/agent';

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(2)} MB`;
}

export function formatDateTime(isoString: string): string {
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return isoString;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatStageLabel(stage: PipelineStage): string {
  switch (stage) {
    case 'brief_submitted':
      return 'Brief Submitted';
    case 'requirements_draft':
      return 'Requirements Draft';
    case 'requirements_ready':
      return 'Requirements Approved';
    case 'agent_built':
      return 'Agent Configured';
    case 'evaluated':
      return 'Evaluated';
    case 'optimized':
      return 'Optimized';
  }
}
