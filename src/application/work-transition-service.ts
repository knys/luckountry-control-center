import type { WorkItem } from "../domain/work-item.js";
import { transitionWorkItem, type TransitionDecision, type WorkEvent } from "../domain/work-state-machine.js";
import type { WorkItemRepository } from "./issue-sync-service.js";

export class WorkTransitionService {
  constructor(private readonly repository: WorkItemRepository) {}
  async transition(id: string, event: WorkEvent): Promise<{ workItem: WorkItem; decision: TransitionDecision }> {
    let decision: TransitionDecision | null = null;
    const workItem = await this.repository.transitionExecutionState(id, (current) => { const result = transitionWorkItem(current, event); decision = result.decision; return result.workItem; });
    if (!decision) throw new Error("transition decision was not produced");
    return { workItem, decision };
  }
}
