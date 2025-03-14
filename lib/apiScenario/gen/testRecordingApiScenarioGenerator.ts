import * as path from "path";
import { inject, injectable } from "inversify";
import { dump as yamlDump } from "js-yaml";
import { HttpHeaders } from "@azure/core-http";
import { cloneDeep } from "lodash";
import { inversifyGetInstance, TYPES } from "../../inversifyUtils";
import { parseValidationRequest } from "../../liveValidation/liveValidator";
import { OperationSearcher } from "../../liveValidation/operationSearcher";
import { JsonLoader } from "../../swagger/jsonLoader";
import * as C from "../../util/constants";
import { SwaggerLoader } from "../../swagger/swaggerLoader";
import { getTransformContext } from "../../transform/context";
import { extractPathParamValue, pathRegexTransformer } from "../../transform/pathRegexTransformer";
import { referenceFieldsTransformer } from "../../transform/referenceFieldsTransformer";
import { applyGlobalTransformers, applySpecTransformers } from "../../transform/transformer";
import { xmsPathsTransformer } from "../../transform/xmsPathsTransformer";
import { ApiScenarioLoaderOption } from "../apiScenarioLoader";
import {
  RawScenarioDefinition,
  RawScenario,
  Scenario,
  StepRestCall,
  Variable,
  RawStepOperation,
  RawVariableScope,
  StepResponseAssertion,
} from "../apiScenarioTypes";
import { ApiScenarioClientRequest } from "../apiScenarioRunner";
import { Operation, Parameter, SwaggerExample } from "../../swagger/swaggerTypes";
import { unknownApiVersion, xmsLongRunningOperation } from "../../util/constants";
import { ArmApiInfo, ArmUrlParser } from "../armUrlParser";
import { SchemaValidator } from "../../swaggerValidator/schemaValidator";
import { getJsonPatchDiff } from "../diffUtils";
import { replaceAllInObject } from "../variableUtils";
import { logger } from ".././logger";
import { FileLoader } from "../../swagger/fileLoader";

const glob = require("glob");

export type SingleRequestTracking = ApiScenarioClientRequest & {
  timeStart?: Date;
  timeEnd?: Date;
  url: string;
  responseBody: any;
  responseCode: number;
  responseHeaders: { [headerName: string]: string };
};

export interface RequestTracking {
  requests: SingleRequestTracking[];
  description: string;
}

export interface TestRecordingApiScenarioGeneratorOption extends ApiScenarioLoaderOption {
  specFolders: string[];
  includeARM: boolean;
}

// const resourceGroupPathRegex = /^\/subscriptions\/[^\/]+\/resourceGroups\/[^\/]+$/i;

interface TestScenarioGenContext {
  resourceTracking: Map<string, StepRestCall>;
  resourceNames: Set<string>;
  variables: Scenario["variables"];
  lastUpdatedResource: string;
}

@injectable()
export class TestRecordingApiScenarioGenerator {
  private testDefToWrite: Array<{ testDef: RawScenarioDefinition; filePath: string }> = [];
  private operationSearcher: OperationSearcher;
  private lroPollingUrls = new Set<string>();
  private scope: RawScenarioDefinition["scope"] = "ResourceGroup";

  public constructor(
    @inject(TYPES.opts) private opts: TestRecordingApiScenarioGeneratorOption,
    private swaggerLoader: SwaggerLoader,
    private jsonLoader: JsonLoader,
    private fileLoader: FileLoader,
    private armUrlParser: ArmUrlParser,
    @inject(TYPES.schemaValidator) private schemaValidator: SchemaValidator
  ) {
    this.operationSearcher = new OperationSearcher((_) => {});
  }
  public static create(opts: TestRecordingApiScenarioGeneratorOption) {
    return inversifyGetInstance(TestRecordingApiScenarioGenerator, opts);
  }

  public async initialize() {
    const swaggerFilePaths = await this.getSwaggerFilePaths();
    const transformCtx = getTransformContext(this.jsonLoader, this.schemaValidator, [
      xmsPathsTransformer,
      referenceFieldsTransformer,
      pathRegexTransformer,
    ]);

    for (const swaggerPath of swaggerFilePaths) {
      const swaggerSpec = await this.swaggerLoader.load(swaggerPath);
      applySpecTransformers(swaggerSpec, transformCtx);
      this.operationSearcher.addSpecToCache(swaggerSpec);
    }
    applyGlobalTransformers(transformCtx);
  }
  private async getSwaggerFilePaths() {
    if (this.opts.includeARM) {
      const idx = this.opts.specFolders[0].indexOf("specification");
      this.opts.specFolders.push(
        path.join(this.opts.specFolders[0].substring(0, idx + "specification".length), "resources")
      );
    }
    return await this.getMatchedPaths(
      this.opts.specFolders.map((s) => path.join(path.resolve(s), "**/*.json"))
    );
  }

  private async getMatchedPaths(jsonsPattern: string | string[]): Promise<string[]> {
    let matchedPaths: string[] = [];
    if (typeof jsonsPattern === "string") {
      matchedPaths = glob.sync(jsonsPattern, {
        ignore: C.DefaultConfig.ExcludedExamplesAndCommonFiles,
        nodir: true,
      });
    } else {
      for (const pattern of jsonsPattern) {
        const res: string[] = glob.sync(pattern, {
          ignore: C.DefaultConfig.ExcludedExamplesAndCommonFiles,
          nodir: true,
        });
        for (const path of res) {
          if (!matchedPaths.includes(path)) {
            matchedPaths.push(path);
          }
        }
      }
    }
    return matchedPaths;
  }

  public async writeGeneratedFiles(recordingPaths: string[]) {
    const testDefToWrite = this.testDefToWrite;
    this.testDefToWrite = [];

    let path = "";
    for (const p of recordingPaths) {
      path += `# ${p}\n`;
    }

    for (const { testDef, filePath } of testDefToWrite) {
      const fileContent =
        "# yaml-language-server: $schema=https://raw.githubusercontent.com/Azure/azure-rest-api-specs/main/documentation/api-scenario/references/v1.2/schema.json\n\n" +
        "# Generated from test-proxy recording in:\n" +
        `${path}` +
        yamlDump(testDef);
      return this.fileLoader.writeFile(filePath, fileContent);
    }
  }

  public async generateTestDefinition(
    requestTracking: RequestTracking[],
    testScenarioFilePath: string
  ): Promise<RawScenarioDefinition> {
    const testDef: RawScenarioDefinition = {
      scope: "ResourceGroup",
      scenarios: [],
    };

    for (const track of requestTracking) {
      const testScenario = await this.generateTestScenario(track, testScenarioFilePath);
      testDef.scenarios.push(testScenario);
    }

    testDef.scope = this.scope;

    this.testDefToWrite.push({ testDef, filePath: testScenarioFilePath });

    return testDef;
  }

  private async generateTestScenario(
    requestTracking: RequestTracking,
    _: string // testDefFilePath
  ): Promise<RawScenario> {
    logger.info(`\nGenerating ${requestTracking.description}`);
    const testScenario: RawScenario = {
      scenario: requestTracking.description.replace(/[^a-zA-Z0-9_]/g, "_"),
      variables: {},
      steps: [],
    };

    const ctx: TestScenarioGenContext = {
      resourceTracking: new Map(),
      resourceNames: new Set(),
      variables: {},
      lastUpdatedResource: "",
    };

    const records = [...requestTracking.requests];
    let lastOperation: Operation | undefined = undefined;
    const steps = [];
    while (records.length > 0) {
      // const record = records[0];
      const testStep = await this.generateTestStepRestCall(records, ctx);
      if (!testStep) {
        continue;
      }

      const { operation } = testStep;
      if (lastOperation === operation && lastOperation?._method === "get") {
        // Skip same get operation
        continue;
      }

      lastOperation = operation;
      steps.push(testStep);
    }

    this.convertVariables(ctx.variables, steps);
    testScenario.steps = steps;
    testScenario.steps.forEach((step) => {
      Object.keys(step.variables ?? {}).forEach((key) => {
        const variable = step.variables![key] as Variable;
        step = step as RawStepOperation;
        if (variable.value !== undefined) {
          step.parameters = step.parameters || {};
          step.parameters[key] = variable.value;
          delete step.variables![key];
        }
      });
      if (Object.keys(step.variables ?? {}).length === 0) {
        step.variables = undefined;
      }
    });

    testScenario.variables = Object.keys(ctx.variables).length > 0 ? ctx.variables : undefined;

    return testScenario;
  }

  private searchOperation(record: SingleRequestTracking) {
    const info = parseValidationRequest(record.url, record.method, "", "");
    try {
      const result = this.operationSearcher.search(info);
      return result.operationMatch;
    } catch (e) {
      return undefined;
    }
  }

  private async handleUnknownPath(
    record: SingleRequestTracking,
    records: SingleRequestTracking[]
  ): Promise<StepRestCall | undefined | null> {
    if (this.lroPollingUrls.has(record.url) && record.method === "GET") {
      return undefined;
    }

    switch (record.method) {
      case "GET":
        return null;

      case "DELETE":
      case "PUT":
        const armInfo = this.armUrlParser.parseArmApiInfo(record.path, record.method);
        await this.skipLroPoll(
          records,
          {
            [xmsLongRunningOperation]: true,
          } as Operation,
          record,
          armInfo
        );
        return null;
    }

    return null;
  }

  private async generateTestStepRestCall(
    records: SingleRequestTracking[],
    ctx: TestScenarioGenContext
  ): Promise<any | undefined | null> {
    const record = records.shift()!;
    const armInfo = this.armUrlParser.parseArmApiInfo(record.path, record.method);

    if (ctx.lastUpdatedResource === armInfo.resourceUri && record.method === "GET") {
      return undefined;
    }

    const responseAssertion = {} as StepResponseAssertion;
    if (record.responseCode >= 400) {
      responseAssertion[record.responseCode] = {};
    }

    const parseResult = this.parseRecord(record);
    if (parseResult === undefined) {
      console.warn(`Skip unknown request:\t${record.method}\t${record.url}`);
      return await this.handleUnknownPath(record, records);
    }
    const { operation, requestParameters } = parseResult;

    if (operation.operationId === "ResourceGroups_CreateOrUpdate") {
      // todo check scope
      return undefined;
    }
    const variables: Scenario["variables"] = {};

    for (const paramKey of Object.keys(requestParameters)) {
      const value = requestParameters[paramKey];
      if (unwantedParams.has(paramKey) || ctx.variables[paramKey]?.value === value) {
        continue;
      }
      let v: Variable;
      if (typeof value === "string") {
        v = { type: "string", value };
      } else if (typeof value === "object") {
        if (Array.isArray(value)) {
          v = { type: "array", value: value };
        } else {
          v = { type: "object", value: value };
        }
      } else if (typeof value === "boolean") {
        v = { type: "bool", value };
      } else if (typeof value === "number") {
        v = { type: "int", value };
      } else {
        console.warn(
          `unknown type of value: ${typeof value}, key: ${paramKey}, method: ${record.method}`
        );
        continue;
      }
      variables[paramKey] = v;
    }

    const step = {
      operationId: operation.operationId!,
      variables: Object.keys(variables).length > 0 ? variables : undefined,
      responses: Object.keys(responseAssertion).length > 0 ? responseAssertion : undefined,
      operation,
    };

    await this.skipLroPoll(records, operation, record, armInfo);

    if (["PUT", "PATCH", "DELETE"].includes(record.method)) {
      // eslint-disable-next-line require-atomic-updates
      ctx.lastUpdatedResource = armInfo.resourceUri;
    }

    return step;
  }

  private async skipLroPoll(
    records: SingleRequestTracking[],
    _operation: Operation,
    initialRecord: SingleRequestTracking,
    armInfo: ArmApiInfo
  ) {
    let finalGet: SingleRequestTracking | undefined = undefined;

    const headers = new HttpHeaders(initialRecord.responseHeaders);
    for (const headerName of ["Operation-Location", "Azure-AsyncOperation", "Location"]) {
      const headerValue = headers.get(headerName);
      if (headerValue !== undefined && headerValue !== initialRecord.url) {
        this.lroPollingUrls.add(headerValue);
      }
    }

    while (records.length > 0) {
      const record = records.shift()!;
      if (record.method === "GET") {
        if (record.path === armInfo.resourceUri) {
          finalGet = record;
          continue;
        }
        if (this.lroPollingUrls.has(record.url)) {
          continue;
        }
      }

      records.unshift(record);
      break;
    }

    return finalGet;
  }

  private parseRecord(record: SingleRequestTracking) {
    const operationMatch = this.searchOperation(record);
    if (operationMatch === undefined) {
      return undefined;
    }

    const { operation } = operationMatch;

    const xHost = operation._path._spec["x-ms-parameterized-host"];

    // if useSchemePrefix is false, the value should add scheme
    if (xHost && xHost.useSchemePrefix === false && operationMatch.pathMatch[1]) {
      operationMatch.pathMatch[1] = record.url.substring(
        0,
        record.url.indexOf(operationMatch.pathMatch[1]) + operationMatch.pathMatch[1].length
      );
    }

    if (operation._path._spec._filePath.includes("data-plane")) {
      this.scope = "None";
    }

    const pathParamValue = extractPathParamValue(operationMatch);
    const requestParameters: SwaggerExample["parameters"] = {
      "api-version": unknownApiVersion,
      ...pathParamValue,
    };

    for (const p of operation.parameters ?? []) {
      const param = this.jsonLoader.resolveRefObj(p);
      const paramValue = getParamValue(record, param);
      if (paramValue !== undefined) {
        requestParameters[param.name] = paramValue;
      }
    }

    return { requestParameters, operation, pathParamValue };
  }

  private convertVariables(
    root: Scenario["variables"],
    scopes: (RawVariableScope & { operation?: Operation })[]
  ) {
    const keyToVariables = new Map<string, Array<Variable>>();
    const unusedVariables = new Set<string>();
    scopes.forEach((v) => {
      Object.entries(v.variables ?? {}).forEach(([key, value]) => {
        value = value as Variable;
        key = `${key}_${typeMap[value.type]}`;
        if (value.type === "string") {
          key = `${key}_${value.value}`;
        }
        const vars = keyToVariables.get(key) ?? [];
        vars.push(value);
        keyToVariables.set(key, vars);
      });
      v.operation?.parameters?.forEach((p) => {
        const param = this.jsonLoader.resolveRefObj(p);
        if (v.variables?.[param.name] === undefined) {
          unusedVariables.add(`${param.name}`);
        }
      });
      delete v.operation;
    });

    keyToVariables.forEach((vars, key) => {
      if (vars.length === 1 || unusedVariables.has(key.split("_")[0])) {
        return;
      }
      const old = cloneDeep(vars[0]);
      const [keyName] = key.split("_");
      if (old.type === "string") {
        if (unreplaceWords.includes(old.value!)) {
          return;
        }
        if (root[keyName] !== undefined) {
          for (let i = 1; ; i++) {
            key = `${keyName}${i}`;
            if (root[key] === undefined) {
              break;
            }
          }
        } else {
          key = keyName;
        }
        root[key] = old;
        replaceAllString(old.value!, key, scopes);
      }
      if (root[keyName] !== undefined) {
        return;
      }
      root[keyName] = old;

      if (old.type === "object" || old.type === "array") {
        for (const newValue of vars) {
          const diff = getJsonPatchDiff(old.value!, newValue.value!);
          if (
            diff.length > 0 &&
            newValue.type == old.type &&
            diff.filter((d) => Object.keys(d).includes("remove")).length <= 2
          ) {
            newValue.patches = diff;
            newValue.value = undefined;
          }

          if (diff.length === 0) {
            newValue.value = undefined;
          }
        }
      }
    });

    scopes.forEach((v) => {
      Object.keys(v.variables ?? {}).forEach((key) => {
        const variable = v.variables![key] as Variable;
        if (variable.type === "array" || variable.type === "object") {
          if (variable.patches === undefined && variable.value === undefined) {
            delete v.variables![key];
          }
        } else if (root[key] && root[key].value === variable.value) {
          delete v.variables![key];
        }
      });
    });
  }
}

const unwantedParams = new Set(["resourceGroupName", "api-version", "subscriptionId"]);

const getParamValue = (record: SingleRequestTracking, param: Parameter) => {
  switch (param.in) {
    case "body":
      if (record.body?.location !== undefined) {
        record.body.location = "$(location)";
      }
      return record.body;

    case "header":
      return record.headers[param.name];

    case "query":
      return record.query[param.name];
  }

  return undefined;
};

const unwantedKeys = new Set(["etag"]);
const eraseUnwantedKeys = (obj: any) => {
  if (obj === null || obj === undefined) {
    return;
  }
  if (typeof obj !== "object") {
    return;
  }
  if (Array.isArray(obj)) {
    for (let idx = 0; idx < obj.length; ++idx) {
      eraseUnwantedKeys(obj[idx]);
    }
    return;
  }
  for (const key of Object.keys(obj)) {
    if (unwantedKeys.has(key.toLowerCase())) {
      obj[key] = undefined;
    } else if (typeof obj[key] === "object") {
      eraseUnwantedKeys(obj[key]);
    }
  }
};

const typeMap = {
  object: "0",
  array: "1",
  bool: "2",
  int: "3",
  string: "4",
  secureString: "5",
  secureObject: "6",
};

const unreplaceWords = ["default"];

const replaceAllString = (toMatch: string, key: string, scopes: RawVariableScope[]) => {
  toMatch = toMatch.toLowerCase();
  scopes.forEach((v) => {
    Object.entries(v.variables ?? {}).forEach(([k, value]) => {
      replaceAllInObject(value, [toMatch], { [`${toMatch}`]: `$(${key})` });
      value = value as Variable;
      if (value.type === "string" && value.value === `$(${k})`) {
        delete v.variables![k];
      }
    });
  });
};
