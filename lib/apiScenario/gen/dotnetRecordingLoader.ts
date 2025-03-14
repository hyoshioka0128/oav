import { basename } from "path";
import { URL } from "url";
import { HttpMethods } from "@azure/core-http";
import { injectable } from "inversify";
import { Loader } from "../../swagger/loader";
import { DEFAULT_ARM_ENDPOINT } from "../constants";
import { logger } from ".././logger";
import { RequestTracking, SingleRequestTracking } from "./testRecordingApiScenarioGenerator";

interface RecordingFile {
  Names: { [testName: string]: string[] };
  Variables: { [variableName: string]: string };
  Entries: RecordingEntry[];
}

interface RecordingEntry {
  RequestUri: string;
  EncodedRequestUri: string;
  RequestMethod: HttpMethods;
  RequestBody: string;
  RequestHeaders: { [headerName: string]: string[] };
  ResponseHeaders: { [headerName: string]: string[] };
  ResponseBody: string;
  StatusCode: number;
}

@injectable()
export class DotnetRecordingLoader implements Loader<RequestTracking, [RecordingFile, string]> {
  public async load([content, filePath]: [RecordingFile, string]): Promise<RequestTracking> {
    const result: RequestTracking = {
      requests: [],
      description: basename(filePath).replace(/\.[^/.]+$/, ""),
    };

    for (const entry of content.Entries) {
      const url = new URL(entry.RequestUri, DEFAULT_ARM_ENDPOINT);
      const query: { [key: string]: string } = {};
      url.searchParams.forEach((val, key) => (query[key] = val));

      const request: SingleRequestTracking = {
        host: DEFAULT_ARM_ENDPOINT,
        method: entry.RequestMethod,
        path: url.pathname,
        url: url.href,
        headers: transformRecordingHeaders(entry.RequestHeaders),
        query,
        body: parseRecordingBodyJson(entry.RequestBody) ?? {},
        responseBody: parseRecordingBodyJson(entry.ResponseBody),
        responseCode: entry.StatusCode,
        responseHeaders: transformRecordingHeaders(entry.ResponseHeaders),
      };

      result.requests.push(request);
    }

    result.requests.sort((a, b) =>
      new Date(a.responseHeaders.Date) < new Date(b.responseHeaders.Date) ? -1 : 1
    );

    // for (const entry of result.requests) {
    //   console.log(`${entry.method}\t${entry.path}`);
    // }

    return result;
  }
}

export const transformRecordingHeaders = (headers: { [headerName: string]: string[] }) => {
  const result: { [headerName: string]: string } = {};
  for (const headerName of Object.keys(headers)) {
    result[headerName] = headers[headerName].join(" ");
  }
  return result;
};

export const parseRecordingBodyJson = (content: string | undefined | null) => {
  if (typeof content !== "string" || content.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(content);
  } catch (e) {
    logger.error(`Failed to parse json body. Use string instead: ${JSON.stringify(content)}`);
    return content;
  }
};
