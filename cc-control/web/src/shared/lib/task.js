/** Stable internal IDs stay in the data model; render the Plan's task key in UI. */
export const taskDisplayId = task => task?.taskKey || task?.task_key || task?.id || '';
