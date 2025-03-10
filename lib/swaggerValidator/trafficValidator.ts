import * as fs from "fs";
import * as path from "path";
import { resolve as pathResolve } from "path";
import { glob } from "glob";
import { FilePosition } from "@azure-tools/openapi-tools-common";
import {
  LiveValidationIssue,
  LiveValidator,
  RequestResponsePair,
} from "../liveValidation/liveValidator";
import { DefaultConfig } from "../util/constants";
import { apiValidationErrors, ErrorCodeConstants } from "../util/errorDefinitions";
import { OperationContext } from "../liveValidation/operationValidator";
import { Options } from "../validate";
import { traverseSwagger } from "../transform/traverseSwagger";
import { Operation, Path, LowerHttpMethods } from "../swagger/swaggerTypes";
import { LiveValidatorLoader } from "../liveValidation/liveValidatorLoader";
import { inversifyGetContainer, inversifyGetInstance } from "../inversifyUtils";
import { findPathsToKey, findPathToValue, getApiVersionFromFilePath } from "../util/utils";
import { SwaggerLoader, SwaggerLoaderOption } from "../swagger/swaggerLoader";
import { getFilePositionFromJsonPath } from "../util/jsonUtils";

export interface TrafficValidationOptions extends Options {
  sdkPackage?: string;
  sdkLanguage?: string;
  reportPath?: string;
  overrideLinkInReport?: boolean;
  outputExceptionInReport?: boolean;
  specLinkPrefix?: string;
  payloadLinkPrefix?: string;
  markdownPath?: string;
}
export interface TrafficValidationIssue {
  payloadFilePath?: string;
  payloadFilePathPosition?: FilePosition | undefined;
  specFilePath?: string;
  errors?: LiveValidationIssue[];
  runtimeExceptions?: RuntimeException[];
  operationInfo?: OperationContext;
}

export interface RuntimeException {
  code: string;
  message: string;
  spec?: string[];
}

export interface OperationCoverageInfo {
  readonly spec: string;
  readonly apiVersion: string;
  readonly coveredOperaions: number;
  readonly validationFailOperations: number;
  readonly unCoveredOperations: number;
  readonly unCoveredOperationsList: OperationMeta[];
  readonly unCoveredOperationsListGen: unCoveredOperationsFormat[];
  readonly totalOperations: number;
  readonly coverageRate: number;
}
export interface OperationMeta {
  readonly operationId: string;
}

export interface unCoveredOperationsFormatInner extends OperationMeta {
  readonly key: string;
}

export interface unCoveredOperationsFormat {
  readonly operationIdList: unCoveredOperationsFormatInner[];
}

export class TrafficValidator {
  private liveValidator: LiveValidator;
  private trafficValidationResult: TrafficValidationIssue[] = [];
  private trafficFiles: string[] = [];
  private specPath: string;
  private trafficPath: string;
  private loader?: LiveValidatorLoader;
  private swaggerLoader?: SwaggerLoader;
  private trafficOperation: Map<string, string[]> = new Map<string, string[]>();
  private validationFailOperations: Map<string, string[]> = new Map<string, string[]>();
  private coverageData: Map<string, number> = new Map<string, number>();
  public operationSpecMapper: Map<string, string[]> = new Map<string, string[]>();
  public operationCoverageResult: OperationCoverageInfo[] = [];
  public operationUndefinedResult: number = 0;

  public constructor(specPath: string, trafficPath: string) {
    this.specPath = specPath;
    this.trafficPath = trafficPath;
  }

  public async initialize() {
    const specPathStats = fs.statSync(this.specPath);
    const trafficPathStats = fs.statSync(this.trafficPath);
    let specFileDirectory = "";
    let swaggerPathsPattern = "**/*.json";
    if (specPathStats.isFile()) {
      specFileDirectory = path.dirname(this.specPath);
      swaggerPathsPattern = path.basename(this.specPath);
    } else if (specPathStats.isDirectory()) {
      specFileDirectory = this.specPath;
    }
    if (trafficPathStats.isFile()) {
      this.trafficFiles.push(this.trafficPath);
    } else if (trafficPathStats.isDirectory()) {
      const searchPattern = path.join(this.trafficPath, "**/*.json");
      const matchedPaths = glob.sync(searchPattern, {
        nodir: true,
      });
      for (const filePath of matchedPaths) {
        this.trafficFiles.push(filePath);
      }
    }

    const liveValidationOptions = {
      checkUnderFileRoot: false,
      loadValidatorInBackground: false,
      directory: specFileDirectory,
      swaggerPathsPattern: [swaggerPathsPattern],
      excludedSwaggerPathsPattern: DefaultConfig.ExcludedExamplesAndCommonFiles,
      git: {
        shouldClone: false,
      },
    };

    this.liveValidator = new LiveValidator(liveValidationOptions);
    await this.liveValidator.initialize();

    const container = inversifyGetContainer();
    this.loader = inversifyGetInstance(LiveValidatorLoader, {
      container,
      fileRoot: liveValidationOptions.directory,
      ...liveValidationOptions,
      loadSuppression: Object.keys(apiValidationErrors),
    });

    const swaggerPaths = this.liveValidator.swaggerList;
    while (swaggerPaths.length > 0) {
      const swaggerPath = swaggerPaths.shift()!;
      let spec;
      try {
        spec = await this.loader.load(pathResolve(swaggerPath));
      } catch (e) {
        console.log(
          `Exception when loading spec, ErrorMessage: ${e?.message}; ErrorStack: ${e?.stack}.`
        );
      }
      if (spec !== undefined) {
        // Get Swagger - operation mapper.
        if (this.operationSpecMapper.get(swaggerPath) === undefined) {
          this.operationSpecMapper.set(swaggerPath, []);
        }
        traverseSwagger(spec, {
          onOperation: (operation: Operation, _path: Path, _method: LowerHttpMethods) => {
            if (
              operation.operationId !== undefined &&
              !this.operationSpecMapper.get(swaggerPath)?.includes(operation.operationId)
            ) {
              this.operationSpecMapper.get(swaggerPath)!.push(operation.operationId);
            }
          },
        });
      }
    }
  }

  public async validate(): Promise<TrafficValidationIssue[]> {
    let payloadFilePath;
    const swaggerOpts: SwaggerLoaderOption = {
      setFilePath: false,
    };
    this.swaggerLoader = inversifyGetInstance(SwaggerLoader, swaggerOpts);

    try {
      for (const trafficFile of this.trafficFiles) {
        payloadFilePath = trafficFile;
        const payload: RequestResponsePair = require(trafficFile);
        const validationResult = await this.liveValidator.validateLiveRequestResponse(payload);
        let operationInfo = validationResult.requestValidationResult?.operationInfo;
        const liveRequest = payload.liveRequest;
        const correlationId = liveRequest.headers?.["x-ms-correlation-request-id"] || "";
        const activityId = liveRequest.headers?.["x-ms-request-id"] || "";
        const opInfo = await this.liveValidator.getOperationInfo(
          liveRequest,
          correlationId,
          activityId
        );

        const errorResult: LiveValidationIssue[] = [];
        const runtimeExceptions: RuntimeException[] = [];
        if (validationResult.requestValidationResult.isSuccessful === undefined) {
          runtimeExceptions.push(validationResult.requestValidationResult.runtimeException!);
        } else if (validationResult.requestValidationResult.isSuccessful === false) {
          errorResult.push(...validationResult.requestValidationResult.errors);
        }

        if (validationResult.responseValidationResult.isSuccessful === undefined) {
          runtimeExceptions.push(validationResult.responseValidationResult.runtimeException!);
        } else if (validationResult.responseValidationResult.isSuccessful === false) {
          errorResult.push(...validationResult.responseValidationResult.errors);
        }
        if (errorResult.length > 0 || runtimeExceptions.length > 0) {
          const trafficSpec = await this.swaggerLoader.load(payloadFilePath);
          let liveRequestResponseList;
          if (validationResult.requestValidationResult.isSuccessful) {
            liveRequestResponseList = findPathsToKey({ key: "liveResponse", obj: trafficSpec });
          } else {
            liveRequestResponseList = findPathsToKey({ key: "liveRequest", obj: trafficSpec });
          }
          const liveRequestResponsePosition = getFilePositionFromJsonPath(
            trafficSpec,
            liveRequestResponseList[0]
          );

          let swaggerFiles: string[] = [];
          if (liveRequest.url.includes("provider")) {
            // This is for validation of resource-manager
            swaggerFiles = this.findSwaggerByOperationInfo(opInfo.info);
          } else {
            // This is for validation of data-plane
            swaggerFiles = this.findSwaggerByOperationId(opInfo.info);
          }

          if (swaggerFiles.length !== 0) {
            for (const swaggerFile of swaggerFiles) {
              if (this.trafficOperation.get(swaggerFile) === undefined) {
                this.trafficOperation.set(swaggerFile, []);
              }
              if (!this.trafficOperation.get(swaggerFile)?.includes(opInfo.info.operationId)) {
                this.trafficOperation.get(swaggerFile)?.push(opInfo.info.operationId);
              }
              if (
                validationResult.requestValidationResult.isSuccessful === false ||
                validationResult.requestValidationResult.isSuccessful === undefined ||
                validationResult.responseValidationResult.isSuccessful === false ||
                validationResult.responseValidationResult.isSuccessful === undefined ||
                validationResult.runtimeException !== undefined
              ) {
                if (this.validationFailOperations.get(swaggerFile) === undefined) {
                  this.validationFailOperations.set(swaggerFile, []);
                }
                if (
                  !this.validationFailOperations.get(swaggerFile)?.includes(opInfo.info.operationId)
                ) {
                  this.validationFailOperations.get(swaggerFile)?.push(opInfo.info.operationId);
                }
              }

              const spec = swaggerFile && (await this.swaggerLoader.load(swaggerFile));
              const operationIdList = findPathsToKey({ key: "operationId", obj: spec });
              const operationId = findPathToValue(operationIdList, spec, operationInfo.operationId);
              const operationIdPosition = getFilePositionFromJsonPath(spec, operationId[0]);
              operationInfo = Object.assign(operationInfo, { position: operationIdPosition });
              this.trafficValidationResult.push({
                specFilePath: swaggerFile,
                payloadFilePath,
                payloadFilePathPosition: liveRequestResponsePosition,
                errors: errorResult,
                runtimeExceptions,
                operationInfo,
              });
            }
          } else {
            console.log(`Error: Undefined operation ${JSON.stringify(opInfo.info)}`);
            this.operationUndefinedResult = this.operationUndefinedResult + 1;
          }
        }
      }
    } catch (err) {
      const msg = `Detail error message:${err?.message}. ErrorStack:${err?.Stack}`;
      this.trafficValidationResult.push({
        payloadFilePath,
        runtimeExceptions: [
          {
            code: ErrorCodeConstants.RUNTIME_ERROR,
            message: msg,
          },
        ],
      });
    }

    let coveredOperaions: number;
    let coverageRate: number;
    let validationFailOperations: number;
    let unCoveredOperationsList: unCoveredOperationsFormatInner[];
    this.operationSpecMapper.forEach((value: string[], key: string) => {
      // identify the spec has been match traffic file
      let isMatch: boolean = true;
      const unCoveredOperationsListFormat: unCoveredOperationsFormat[] = [];
      unCoveredOperationsList = [];
      if (this.trafficOperation.get(key) === undefined) {
        coveredOperaions = 0;
        coverageRate = 0;
        this.coverageData.set(key, 0);
        isMatch = false;
      } else if (value !== undefined && value.length !== 0) {
        const validatedOperations = this.trafficOperation.get(key);
        coveredOperaions = validatedOperations!.length;
        coverageRate = coveredOperaions / value.length;
        this.coverageData.set(key, coverageRate);
        const unValidatedOperations = [...value];
        validatedOperations!.forEach((element) => {
          unValidatedOperations.splice(unValidatedOperations.indexOf(element), 1);
        });
        unValidatedOperations.forEach((element) => {
          unCoveredOperationsList.push({
            key: element.split("_")[0],
            operationId: element,
          });
        });
        const unCoveredOperationsInnerList: unCoveredOperationsFormatInner[][] = Object.values(
          unCoveredOperationsList.reduce(
            (res: { [key: string]: unCoveredOperationsFormatInner[] }, item) => {
              /* eslint-disable no-unused-expressions */
              res[item.key] ? res[item.key].push(item) : (res[item.key] = [item]);
              /* eslint-enable no-unused-expressions */
              return res;
            },
            {}
          )
        );
        unCoveredOperationsInnerList.forEach((element) => {
          unCoveredOperationsListFormat.push({
            operationIdList: element,
          });
        });
      } else {
        isMatch = false;
        coveredOperaions = 0;
        coverageRate = 0;
        this.coverageData.set(key, 0);
      }

      if (this.validationFailOperations.get(key) === undefined) {
        validationFailOperations = 0;
      } else {
        validationFailOperations = this.validationFailOperations.get(key)!.length;
      }
      const sortedUnCoveredOperationsList = unCoveredOperationsList.sort(function (op1, op2) {
        const opId1 = op1.operationId;
        const opId2 = op2.operationId;
        if (opId1 < opId2) {
          return -1;
        }
        if (opId1 > opId2) {
          return 1;
        }
        return 0;
      });

      /**
       * Sort untested operationId by bubble sort
       * Controlling the results of localeCompare can set the sorting method
       * X.localeCompare(Y) > 0 descending sort
       * X.localeCompare(Y) < 0 ascending sort
       */
      for (let i = 0; i < unCoveredOperationsListFormat.length - 1; i++) {
        for (let j = 0; j < unCoveredOperationsListFormat.length - 1 - i; j++) {
          if (
            unCoveredOperationsListFormat[j].operationIdList[0].key.localeCompare(
              unCoveredOperationsListFormat[j + 1].operationIdList[0].key
            ) > 0
          ) {
            var temp = unCoveredOperationsListFormat[j];
            unCoveredOperationsListFormat[j] = unCoveredOperationsListFormat[j + 1];
            unCoveredOperationsListFormat[j + 1] = temp;
          }
        }
      }

      isMatch &&
        this.operationCoverageResult.push({
          spec: key,
          apiVersion: getApiVersionFromFilePath(key),
          coveredOperaions: coveredOperaions,
          coverageRate: coverageRate,
          unCoveredOperations: value.length - coveredOperaions,
          totalOperations: value.length,
          validationFailOperations: validationFailOperations,
          unCoveredOperationsList: sortedUnCoveredOperationsList,
          unCoveredOperationsListGen: unCoveredOperationsListFormat,
        });
    });
    return this.trafficValidationResult;
  }

  private findSwaggerByOperationInfo(operationInfo: OperationContext): string[] {
    let result: string[] = [];
    if (operationInfo.validationRequest === undefined) {
      return result;
    }
    for (const key of this.operationSpecMapper.keys()) {
      const value = this.operationSpecMapper.get(key);
      if (
        key.toLowerCase().includes(operationInfo.validationRequest?.providerNamespace) &&
        (key.includes(operationInfo.apiVersion) ||
          key.toLowerCase().includes(operationInfo.apiVersion))
      ) {
        if (value!.includes(operationInfo.operationId)) {
          result.push(key);
        }
      }
    }
    return result;
  }

  private findSwaggerByOperationId(operationInfo: OperationContext): string[] {
    let result: string[] = [];
    for (const key of this.operationSpecMapper.keys()) {
      const value = this.operationSpecMapper.get(key);
      if (
        value!.includes(operationInfo.operationId) &&
        (key.includes(operationInfo.apiVersion) ||
          key.toLowerCase().includes(operationInfo.apiVersion))
      ) {
        result.push(key);
      }
    }
    return result;
  }
}
