import { existsSync, writeFileSync } from "fs";
import { mkdirpSync} from "fs-extra";
import { injectable } from "inversify";
import { dump } from "js-yaml";
import _ from "lodash";
import { dirname, join } from "path";
import { inversifyGetInstance } from "../../inversifyUtils";
import { JsonLoader } from "../../swagger/jsonLoader";
import { setDefaultOpts } from "../../swagger/loader";
import { SwaggerLoader, SwaggerLoaderOption } from "../../swagger/swaggerLoader";
import { Path, SwaggerSpec } from "../../swagger/swaggerTypes";
import { traverseSwagger } from "../../transform/traverseSwagger";
import { xmsLongRunningOperation } from "../../util/constants";
import { RawScenarioDefinition} from "../apiScenarioTypes";
import { RestlerApiScenarioGenerator } from "./restlerApiScenarioGenerator";
import { ResourceNameCaseInsensitive } from "./rules/resourceNameCaseInsensitive";
import { SystemDataExistsInResponse } from "./rules/systemDataExistsInResponse";

export type HttpVerb = "get" | "put" | "post" | "patch" | "delete" | "head";
export type ArmResourceKind = "Tracked" | "Proxy" | "Extension" | "None";
export type ResourceBasicOperationKind = "Get" | "CreateOrUpdate" | "Update" | "Delete"
export type ResourceOperationKind = ResourceBasicOperationKind | "Action" | "List"
export type PlatFormType = "RPaaS" | "ARM";

export type ApiTestGeneratorRule = {
  name: string;
  description: string;
  armRpcCodes?: string[]
  resourceKinds?: ArmResourceKind[];
  appliesTo: PlatFormType[];
  useExample?:boolean,
  generator: ApiTestGenerator;
};

type ApiTestGenerator = (resource:ArmResourceManipulator,base: RawScenarioDefinition)=> RawScenarioDefinition | null

type ResourceOperation = {
  path: string;
  operationId: string;
  parameters?: [];
  responses?: {[index:string]:any};
  examples: string[];
  [xmsLongRunningOperation]?: boolean;
  kind: ResourceOperationKind;
};

export interface ArmResourceManipulatorInterface {
  getResourceOperation(kind: ResourceBasicOperationKind): ResourceOperation;
  getListOperations(): ResourceOperation[];
  getResourceActions(): ResourceOperation[];
  getProperty(propName: string): any;
  getProperties(): any[];
  getParentResource(): ArmResourceManipulatorInterface[];
  getChildResource(): ArmResourceManipulatorInterface[];
}

/*
const ResourceBasicApiTestGenerator = {
  genResourceDependency: (resource: ArmResourceManipulator) => {

  },
  genBasic:(resource:ArmResourceManipulator)=> {},
  genResourceCreate: (resource: ArmResourceManipulator):RawStepOperation => {
    return {
      operationId: resource.getOperation("CreateOrUpdate")[0].operationId,
    }
  },
  genResourceUpdate: (resource: ArmResourceManipulator) => {},
  genResourceGet: (resource: ArmResourceManipulator) => {},
  genResourceDelete: (resource: ArmResourceManipulator) => {},
};*/

// the class for manipulate the resource , includeing 
//  get CRUD, list, actions operations 
export class ArmResourceManipulator implements ArmResourceManipulatorInterface {
  constructor(
    private swagger: SwaggerSpec,
    private jsonLoader: JsonLoader,
    private resAnalyzer: ArmResourceAnalyzer,
    private resourceType: string,
    private path: string
  ) {}
  getListOperations(): ResourceOperation[] {
    return this.resAnalyzer
      .getResourceActions()
      .filter((res) => res.getResourceType() === this.getResourceType() && res.isListResource())
      .map((res) => res.getOperation("List"))
      .reduce((pre, cur) => pre.concat(cur),[]) || [];
  }
  getResourceActions(): ResourceOperation[] {
    return this.resAnalyzer
      .getResourceActions()
      .filter((res) => res.getResourceType() === this.getResourceType() && res.isListResource())
      .map((res) => res.getOperation("Action"))
      .reduce((pre, cur) => pre.concat(cur),[]);
  }
  getResourceOperation(kind: ResourceBasicOperationKind): ResourceOperation {
    return this.getOperation(kind)?.[0];
  }
  getResourceType() {
    return this.resourceType;
  }
  public getOperation(kind: ResourceOperationKind): ResourceOperation[] {
    const ops: ResourceOperation[] = [];
    traverseSwagger(this.swagger, {
      onPath: (path: Path, pathTemplate: string) => {
        if (pathTemplate === this.path) {
          function getHttpVerb(kind: ResourceOperationKind) {
            const map: { [index in ResourceOperationKind]: string } = {
              CreateOrUpdate: "put",
              Get: "get",
              Update: "patch",
              Delete: "delete",
              List: "get",
              Action: "post",
            };
            return map[kind] as string;
          }
          function getRawOperation(kind: ResourceOperationKind) {
            return (path as any)[getHttpVerb(kind)];
          }
          const rawOperation = getRawOperation(kind);
          if (rawOperation && rawOperation.operationId) {
            const operation = {
              operationId: rawOperation.operationId!,
              parameters: this.jsonLoader.resolveRefObj(rawOperation.parameters! as any),
              responses: this.jsonLoader.resolveRefObj(rawOperation.responses!),
              path: pathTemplate!,
              kind,
              examples: Object.values(rawOperation["x-ms-examples"]|| {})?.map((e) =>
                this.jsonLoader.getRealPath((e as any).$ref)
              ),
            };
            ops.push(operation);
          }
        }
      },
    });
    return ops;
  }
  private getPropertyInternal(schema: any, propName: string): any {
    const resolvedSchema = this.jsonLoader.resolveRefObj(schema);
    if (resolvedSchema.properties) {
      if (propName in resolvedSchema.properties) {
        return resolvedSchema.properties[propName];
      }
    }
    if (resolvedSchema.allOf && Array.isArray(resolvedSchema.allOf)) {
      for (const base of resolvedSchema.allOf) {
        const result = this.getPropertyInternal(base, propName);
        if (result) {
          return result;
        }
      }
    }
    return undefined;
  }

  getProperty(propName: string): any {
    const response =
    this.getResourceOperation("CreateOrUpdate")?.responses?.["200"] ||
    this.getResourceOperation("CreateOrUpdate")?.responses?.["201"] ||
    this.getResourceOperation("Get")?.responses?.["200"];
    if (response?.schema) {
      return this.getPropertyInternal(response?.schema,propName);
    }
    return undefined;
  }
  getProperties(): any[] {
   return []
  }

  public isTrackedResource() {
    const putOp = this.getOperation("CreateOrUpdate")?.[0];
    if (putOp) {
      return Object.entries(putOp.responses || [])
        .filter((entry) => entry[0] !== "default")
        .map((entry) => (entry[1] as any).schema)
        .some((schema) => schema && this.getPropertyInternal(schema, "location"));
    }
    return false;
  }

  public isExtensionResource() {
    const regEx = new RegExp(".*/providers/[^/]+/.*/providers/.*$", "gi");
    return regEx.test(this.path);
  }

  public isListResource() {
    const regex = /.*_list.*/gi;
    const matches = this.getOperation("Get")?.[0]?.operationId?.match(regex);
    return !!matches;
  }

  public isResourceAction() {
    const result = this.getOperation("Action")?.[0];
    return !!result;
  }

  private isSamePath(a: string, b: string) {
    const regex = /\{[\w\.]+\}/g;
    return a.replace(regex, "{}") === b.replace(regex, "{}");
  }
  private getParentResourcePath(path: string) {
    return path.split("/").slice(0, -2).join("/");
  }

  public getParentResource() {
    const parenetResPath = this.getParentResourcePath(this.path);
    return this.resAnalyzer
      .getResources()
      .filter((res) => this.isSamePath(res.path, parenetResPath));
  }
  public getChildResource() {
    return this.resAnalyzer
      .getResources()
      .filter((res) => this.isSamePath(this.getParentResourcePath(res.path), this.path));
  }
}

class ArmResourceDependencyGenerator {
  constructor(
    private _swagger: string,
    private _dependencyFile: string,
    private _outPutDir: string,
    private _basicScenarioFile?:string
  ) {}
  async generate(resoure: ArmResourceManipulator,useExample?:boolean) {
    const restlerGenerator = RestlerApiScenarioGenerator.create({
      outputDir: this._outPutDir,
      dependencyPath: this._dependencyFile,
      swaggerFilePaths: [this._swagger],
      useExample:useExample
    });
    await restlerGenerator.initialize();
    if (!this._basicScenarioFile) {
      return restlerGenerator.generateResourceDependency(resoure);
    }
    else {
      //TBD
      return null
    }
  }
}

class ArmResourceAnalyzer {
  private _resources: ArmResourceManipulator[] | undefined;
  private _actions: ArmResourceManipulator[] | undefined;
  constructor(private _swagger: SwaggerSpec, private _jsonLoader: JsonLoader) {
    this.getResources();
  }

  public getResources() {
    if (this._resources) {
      return this._resources;
    }
    this._resources = [];
    const specificResourcePathRegEx = new RegExp(
      "/providers/[^/]+(?:/\\w+/default|/\\w+/{[^/]+})+$",
      "gi"
    );
    const getResourceType = (path: string) => {
      const segments = path.split("/");
      return segments.length > 2 ? segments[segments.length - 2] : "";
    };
    traverseSwagger(this._swagger, {
      onPath: (path: Path, pathTemplate: string) => {
        const resType = getResourceType(pathTemplate);
        if (specificResourcePathRegEx.test(pathTemplate) && path.put && resType) {
          const resource = new ArmResourceManipulator(
            this._swagger,
            this._jsonLoader,
            this,
            resType,
            pathTemplate
          );
          this._resources?.push(resource);
        }
      },
    });
    return this._resources;
  }

  public getResourceActions() {
    if (this._actions) {
      return this._actions
    }
    const resources = this.getResources();
    const resourceActionRegEx = new RegExp(
      "/providers/[^/]+(?:/\\w+/\\w+|/\\w+/{[^/]+})*/\\w+$",
      "gi"
    );
    const getResourceType = (path: string) => {
      const segments = path.split("/");
      // check if list operations, the last segment is the resource types
      let type = segments[segments.length - 1];
      if (resources.find(res => res.getResourceType() === type)) {
        return type
      }
      // it's resource actions
      return segments.length > 3 ? segments[segments.length - 3] : "";
    };
    this._actions = []
    traverseSwagger(this._swagger, {
      onPath: (_path: Path, pathTemplate: string) => {
        const resType = getResourceType(pathTemplate);
        if (resourceActionRegEx.test(pathTemplate) && resType) {
          const resourceMani = new ArmResourceManipulator(
            this._swagger,
            this._jsonLoader,
            this,
            resType,
            pathTemplate
          );
          this._actions?.push(resourceMani);
        }
      },
    });
    return this._actions
  }

  public getTrackedResource(): ArmResourceManipulator[] {
    return this.getResources().filter((res) => res.isTrackedResource());
  }

  public getProxyResource() {
    return this.getResources().filter((res) => !res.isTrackedResource());
  }

  public getExtensionResource() {
    return this.getResources().filter((res) => res.isExtensionResource());
  }
}

@injectable()
export class ApiTestRuleBasedGenerator {
  constructor(private swaggerLoader: SwaggerLoader, private jsonLoader:JsonLoader,private rules: ApiTestGeneratorRule[], private swaggerFile: string,private dependencyFile?:string,private basicScenarioFile?:string) {}

  async run(outputDir:string,platFormType:PlatFormType) {
    const swaggerSpec = await this.swaggerLoader.load(this.swaggerFile);
    const analyzer = new ArmResourceAnalyzer(swaggerSpec,this.jsonLoader);
    const trackedResources = analyzer.getTrackedResource();
    const proxyResources = analyzer.getProxyResource();
    const extensionResources = analyzer.getExtensionResource();
    const scenariosResult :{[index:string]:RawScenarioDefinition} = {}
    const  generateForResources = async (resources: ArmResourceManipulator[],kind:ArmResourceKind) => {
       for (const resource of resources) {
         for (const rule of this.rules.filter(
           (rule) => rule.resourceKinds?.includes(kind) && rule.appliesTo.includes(platFormType)
         )) {
           // what if without dependency ??
           if (this.dependencyFile) {
             const dependency = new ArmResourceDependencyGenerator(
               this.swaggerFile,
               this.dependencyFile,
               outputDir,this.basicScenarioFile
             );
             const base = await dependency.generate(resource, rule.useExample);
             if (base) {
               const apiSenarios = rule.generator(resource, base);
               if (apiSenarios) {
                 scenariosResult[rule.name] = apiSenarios;
                 this.writeFile(rule.name, resource.getResourceType(), apiSenarios, outputDir);
               }
             }

           }
         }
       }
    }
    await generateForResources(trackedResources,"Tracked")
    await generateForResources(proxyResources,"Proxy")
    await generateForResources(extensionResources,"Extension")
   
  }

  writeFile(ruleName:string,resourType:string,scenario:RawScenarioDefinition,outputDir:string) {
     const fileContent = dump(scenario);
     const filePath = join(outputDir, ruleName,`${resourType}.yaml`);
     if (!existsSync(dirname(filePath))) {
      mkdirpSync(dirname(filePath))
     }
     writeFileSync(filePath, fileContent);
     console.log(`${filePath} is generated.`);
  }
}

export const generateApiTestBasedOnRules = async (swaggers:string[],dependencyFile:string,outputDir:string,isRPaaS?:string) =>{
  const opts: SwaggerLoaderOption = {};
  setDefaultOpts(opts, {
    eraseXmsExamples: false,
    skipResolveRefKeys: ["x-ms-examples"],
  });
  const swaggerLoader = inversifyGetInstance(SwaggerLoader, opts);
  const jsonLoader = inversifyGetInstance(JsonLoader, opts);
  const rules:ApiTestGeneratorRule[] = [ResourceNameCaseInsensitive, SystemDataExistsInResponse];
  for (const swagger of swaggers) {
    const generator =   new ApiTestRuleBasedGenerator(swaggerLoader,jsonLoader,rules,swagger,dependencyFile)
    await generator.run(outputDir,isRPaaS?"RPaaS":"ARM")
  }
}