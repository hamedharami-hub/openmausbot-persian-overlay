import { expect, it } from "vitest";
import { availableTools, catalogProfileFromEnv } from "./agents-catalog.ts";

it("advertises project actions only in a project turn, with chief decisions restricted to chiefs", () => {
  const tools = (env: NodeJS.ProcessEnv) => availableTools(catalogProfileFromEnv(env)).map(tool => tool.name);
  expect(tools({ OMB_CHIEF_OF_STAFF: "1" })).not.toContain("propose_project_task");
  expect(tools({ OMB_CHIEF_OF_STAFF: "1" })).not.toContain("decide_project_task");
  expect(tools({ OMB_PROJECT_ACTIVE: "1" })).toContain("propose_project_task");
  expect(tools({ OMB_PROJECT_ACTIVE: "1" })).not.toContain("decide_project_task");
  expect(tools({ OMB_PROJECT_ACTIVE: "1", OMB_CHIEF_OF_STAFF: "1" })).toContain("decide_project_task");
});
