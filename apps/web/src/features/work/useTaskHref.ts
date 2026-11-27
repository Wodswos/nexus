import { isProject } from "@nexus/core";
import { useNexusData } from "@nexus/crdt";
import { projectView, useProjectViewMemory } from "../tasks/projectViews";
import { taskPath, taskViewHref } from "../tasks/taskNavigation";

/** Jump to the owning project without replacing its remembered view. */
export function useTaskHref() {
  const data = useNexusData();
  const memory = useProjectViewMemory();
  return (id: string): string | null => {
    const project = taskPath(data.tasks, id).find(isProject);
    return (
      taskViewHref(
        data,
        id,
        project ? projectView(memory, project.id) : "list",
      ) ?? taskViewHref(data, id, "list")
    );
  };
}
