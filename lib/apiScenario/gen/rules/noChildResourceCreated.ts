import { RawScenario, RawStep } from "../../apiScenarioTypes";
import { ApiTestGeneratorRule, ArmResourceManipulatorInterface } from "../ApiTestRuleBasedGenerator";

export const NoChildResourceCreated: ApiTestGeneratorRule = {
  name: "NoChildResourceCreated",
  armRpcCodes: ["RPC-V1-Common-1"],
  description: "Check if put operation will create nested resoruce implicitly.",
  resourceKinds: ["Tracked", "Extension"],
  appliesTo: ["ARM"],
  useExample: true,
  generator: (resource: ArmResourceManipulatorInterface, base: RawScenario) => {
    const childResources = resource.getChildResource();
    if (childResources.length === 0) {
      return null;
    }
    let hit = false
    for (resource of childResources) {
      const listOperation = resource.getListOperations()[0]
      if (listOperation && listOperation.examples[0]) {
        const step:RawStep = {
          operationId: listOperation.operationId,
          responses: {200: {body:{ value:[]}}}
        };
        base.steps.push(step);
        hit = true;
      }
    }
    return hit ? base : null
  },
};
