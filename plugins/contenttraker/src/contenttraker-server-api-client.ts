import { request as httpsRequest } from "node:https";

export interface JsonResponse {
  ok: boolean;
  statusCode: number;
  json: unknown;
  correlationId?: string;
}

export interface ContentTrakerServerApiClient {
  getJson(baseUrl: string, path: string, authorization: string, correlationId: string): Promise<JsonResponse>;
  postJson(baseUrl: string, path: string, authorization: string, body: unknown, correlationId: string): Promise<JsonResponse>;
  putJson(baseUrl: string, path: string, authorization: string, body: unknown, correlationId: string): Promise<JsonResponse>;
}

export class NodeContentTrakerServerApiClient implements ContentTrakerServerApiClient {
  getJson(baseUrl: string, path: string, authorization: string, correlationId: string): Promise<JsonResponse> {
    return this.sendJson("GET", baseUrl, path, authorization, correlationId);
  }

  postJson(baseUrl: string, path: string, authorization: string, body: unknown, correlationId: string): Promise<JsonResponse> {
    return this.sendJson("POST", baseUrl, path, authorization, correlationId, body);
  }

  putJson(baseUrl: string, path: string, authorization: string, body: unknown, correlationId: string): Promise<JsonResponse> {
    return this.sendJson("PUT", baseUrl, path, authorization, correlationId, body);
  }

  private sendJson(
    method: "GET" | "POST" | "PUT",
    baseUrl: string,
    path: string,
    authorization: string,
    correlationId: string,
    body?: unknown,
  ): Promise<JsonResponse> {
    const url = new URL(path, ensureTrailingSlash(baseUrl));
    if (url.protocol !== "https:" || url.username || url.password) {
      return Promise.reject(new Error("ContentTraker API transport requires an HTTPS URL without embedded credentials."));
    }

    const requestBody = body === undefined ? undefined : JSON.stringify(body);

    return new Promise((resolve, reject) => {
      const requestMessage = httpsRequest(
        url,
        {
          method,
          agent: false,
          headers: {
            authorization,
            "x-correlation-id": correlationId,
            accept: "application/json",
            ...(requestBody === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(requestBody).toString(),
                }),
            connection: "close",
          },
        },
        (response) => {
          let text = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            text += chunk;
          });
          response.on("end", () => {
            const statusCode = response.statusCode ?? 0;
            resolve({
              ok: statusCode >= 200 && statusCode < 300,
              statusCode,
              json: parseJson(text),
              correlationId: normalizeHeader(response.headers["x-correlation-id"]),
            });
          });
        },
      );

      requestMessage.setTimeout(15_000, () => {
        requestMessage.destroy(new Error("ContentTraker API request timed out."));
      });
      requestMessage.on("error", reject);
      if (requestBody !== undefined) {
        requestMessage.write(requestBody);
      }
      requestMessage.end();
    });
  }
}

function normalizeHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function ensureTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }

  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
