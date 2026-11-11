// Голосові команди налаштування Todoist: проєкти, мітки та їхні описи.

export { setupCommands, setupReport } from "./apply";
export { planSetup } from "./plan";
export { labelRule, setLabelRule } from "./rules";
export { runSetup } from "./run";
export type { SetupPlan, SetupState, SetupWorld } from "./types";
export { clean } from "./utils";
export { validateSetup } from "./validate";
