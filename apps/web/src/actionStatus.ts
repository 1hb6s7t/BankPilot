import type { ActionView } from '../../../packages/contracts/src';

/** Shared by the workspace and goal detail so the same transfer has the same label. */
export function transferStatusLabel(status: ActionView['status']): string {
  const labels: Record<ActionView['status'], string> = {
    AWAITING_CONFIRMATION: '待本人确认',
    AWAITING_VERIFICATION: '待安全验证',
    AUTHORIZED: '已授权 · 等待执行',
    SUBMITTING: '正在提交',
    UNKNOWN: '结果待查',
    SUCCEEDED: '已完成',
    FAILED: '执行失败',
    CANCELLED: '已取消',
    EXPIRED: '已过期',
  };
  return labels[status];
}
