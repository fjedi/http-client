/* eslint-disable indent, lines-between-class-members */
import axios, {
  Method,
  AxiosInstance,
  AxiosRequestConfig,
  AxiosProxyConfig,
  AxiosError,
  ResponseType,
  AxiosResponse,
  AxiosBasicCredentials,
  AxiosTransformer,
} from 'axios';
import tunnel from 'tunnel';
import { get, set, omit, pick } from 'lodash';
import { DefaultError } from '@fjedi/errors';
import { redis } from '@fjedi/redis-client';

type TodoAny = unknown;

export type { Method, ResponseType } from 'axios';
export type Response = AxiosResponse;
export type BasicAuthCredentials = AxiosBasicCredentials;
export type ProxyConfig = AxiosProxyConfig;

//
export type HTTPClientProps = {
  baseURL?: string;
  threads?: number;
  timeout?: number;
  cachePeriod?: number;
  headers?: AxiosRequestConfig['headers'];
  proxy?: AxiosProxyConfig;
  withCredentials?: boolean;
  databaseLogging?: boolean | TodoAny;
  auth?: AxiosBasicCredentials;
  validateStatus?: (status: number) => boolean;
  getDataFromResponse?: (response: Response) => Response['data'];
  getErrorFromResponse?: (error: AxiosError) => TodoAny;
  transformRequest?: AxiosTransformer | AxiosTransformer[];
  transformResponse?: AxiosTransformer | AxiosTransformer[];
};

export interface RequestConfig extends AxiosRequestConfig {
  extendField?: string;
}

export type Headers = {
  responseType?: ResponseType;
  'Content-Type'?: string;
};

export type AxiosAgentProps = {
  proxy?: AxiosProxyConfig;
};

type Context = {
  logger: TodoAny;
  db: TodoAny;
};

//
const SECURE_FIELDS = new Set([
  'config.auth.password',
  'config.auth.username',
  'config.data.password',
  'config.data.token',
  'config.headers.Authorization',
]);

//
export class HTTPClient {
  client: AxiosInstance;
  redis: TodoAny;
  cachePeriod: number;
  requestTimeout: number;
  getDataFromResponse: (response: AxiosResponse) => Response['data'];
  getErrorFromResponse: (error: AxiosError) => TodoAny;
  // @ts-ignore: will be done later
  validateStatus: (status: number) => boolean;
  pendingRequests = 0;
  baseURL?: string;

  constructor(props: HTTPClientProps, context?: Context) {
    const {
      timeout = 3000, // by default we cache all requests for 3 seconds
      cachePeriod = 0,
      // "proxy" - объект, который имеет обязательные поля "host" и "port
      // а также необязательное поле "auth", которое если указано, то должно быть объектом
      // с полями user и password
      proxy,
      headers,
      // Функция, которую можно объявить для обозначения логики формирования
      // отформатированного объекта ошибки
      getErrorFromResponse,
      getDataFromResponse,
      baseURL,
      transformRequest,
      transformResponse,
      validateStatus,
      // Concurrency settings
      threads = 60,
      // Basic auth params
      auth,
      withCredentials,
    } = props;
    let {
      // Should we save queryLogs to database
      databaseLogging = false,
    } = props;
    //
    const RemoteServerQueryLog = get(context, 'db.models.RemoteServerQueryLog');
    if (!RemoteServerQueryLog) {
      databaseLogging = false;
    }
    //
    const userId = get(context, 'state.user.id');
    const ip = get(context, 'state.clientIP');
    //
    this.baseURL = baseURL;
    this.cachePeriod = cachePeriod;
    this.requestTimeout = timeout || 30000;
    //
    this.getDataFromResponse =
      typeof getDataFromResponse === 'function' ? getDataFromResponse : (res) => res.data;
    //
    this.getErrorFromResponse =
      typeof getErrorFromResponse === 'function'
        ? getErrorFromResponse
        : (error) => {
            const code =
              get(error, 'response.data.code') || get(error, 'response.error.code') || error.code;
            const status =
              get(error, 'response.data.status') ||
              get(error, 'response.error.status') ||
              get(error, 'status') ||
              0;
            const statusText = get(error, 'response.statusText');
            const message =
              get(error, 'response.data.message') ||
              get(error, 'response.error.message') ||
              error.message ||
              statusText;
            const {
              serviceName = baseURL || 'unknown-service',
              errorCode = code || 'unknown-error-code',
              description = message,
            } = get(error, 'response.data', {});
            // @ts-ignore
            return new DefaultError(message, {
              status,
              meta: {
                code,
                statusText,
                serviceName,
                errorCode,
                description,
                ...pick(get(error, 'config') || {}, ['data', 'url', 'method']),
                // @ts-ignore
                ...(error.data || {}),
              },
              originalError: error,
            });
          };
    //
    const clientProps: AxiosRequestConfig = {
      baseURL,
      timeout,
      proxy: false,
      auth,
      withCredentials,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'node/1.0.0',
        ...headers,
      },
    };
    if (typeof validateStatus === 'function') {
      clientProps.validateStatus = validateStatus;
    }
    if (typeof transformRequest === 'function') {
      clientProps.transformRequest = [transformRequest];
    }
    if (typeof transformResponse === 'function') {
      clientProps.transformResponse = [transformResponse];
    }
    if (proxy) {
      const agentProps: AxiosAgentProps = {};
      agentProps.proxy = {
        host: get(proxy, 'host'),
        port: get(proxy, 'port'),
      };
      //
      const userAgent = get(proxy, 'userAgent');
      if (userAgent) {
        clientProps.headers['User-Agent'] = userAgent;
      }
      //
      const proxyAuth = get(proxy, 'auth');
      if (proxyAuth) {
        const { username, password } = proxyAuth;
        // @ts-ignore
        agentProps.proxy.proxyAuth = `${username}:${password}`;
      }
      clientProps.httpsAgent = tunnel.httpsOverHttp(agentProps);
    }
    //
    this.client = axios.create(clientProps);
    //
    this.client.interceptors.request.use((config) => {
      return new Promise((resolve) => {
        const interval = setInterval(() => {
          if (this.pendingRequests < threads) {
            this.pendingRequests += 1;
            clearInterval(interval);
            resolve(config);
          }
        }, 100);
      });
    });

    this.client.interceptors.response.use(
      async (response) => {
        this.pendingRequests = Math.max(0, this.pendingRequests - 1);
        //
        if (!databaseLogging) {
          return response;
        }
        if (typeof databaseLogging === 'function') {
          const shouldLog = databaseLogging(response);
          if (!shouldLog) {
            return response;
          }
        }
        //
        const queryConfig: RequestConfig = pick(get(response, 'config', {}), [
          'method',
          'baseURL',
          'url',
          'params',
          'data',
          'headers',
        ]);
        const { method, url = '', params = {} } = queryConfig;
        let { data = {} } = queryConfig;
        //
        const filteredHeaders = {};
        //
        Object.keys(queryConfig.headers).forEach((headerKey) => {
          //
          const privateHeader =
            headerKey.toLowerCase().includes('key') ||
            headerKey.toLowerCase().includes('token') ||
            headerKey.toLowerCase().includes('password');
          if (privateHeader) {
            // @ts-ignore
            filteredHeaders[headerKey] = '[FILTERED]';
          } else {
            // @ts-ignore
            filteredHeaders[headerKey] = queryConfig.headers[headerKey];
          }
        });
        try {
          data =
            typeof queryConfig.data === 'string' && queryConfig.data
              ? JSON.parse(queryConfig.data)
              : queryConfig.data;
        } catch (requestDataParseError) {
          // Ignore data-parse error
        }
        //
        const queryResponse = {
          status: get(response, 'status', 0),
          statusText: get(response, 'statusText', ''),
          method,
          baseURL: queryConfig.baseURL,
          url,
          params,
          data,
          config: queryConfig,
          headers: filteredHeaders,
          response: omit(response, ['request', 'config']),
          ip,
          userId,
        };
        // Response Schema
        // {
        //   // `data` is the response that was provided by the server
        //   data: {},
        //
        //   // `status` is the HTTP status code from the server response
        //   status: 200,
        //
        //   // `statusText` is the HTTP status message from the server response
        //   statusText: 'OK',
        //
        //   // `headers` the headers that the server responded with
        //   // All header names are lower cased
        //   headers: {},
        //
        //   // `config` is the config that was provided to `axios` for the request
        //   config: {},
        //
        //   // `request` is the request that generated this response
        //   // It is the last ClientRequest instance in node.js (in redirects)
        //   // and an XMLHttpRequest instance the browser
        //   request: {}
        // }
        //
        await RemoteServerQueryLog.create(queryResponse);
        //
        return response;
      },
      async (err: AxiosError) => {
        this.pendingRequests = Math.max(0, this.pendingRequests - 1);
        //
        if (!databaseLogging) {
          //
          throw err;
        }
        if (typeof databaseLogging === 'function') {
          const shouldLog = databaseLogging(err);
          if (!shouldLog) {
            throw err;
          }
        }
        //
        const queryConfig: RequestConfig = pick(get(err, 'config', {}), [
          'method',
          'baseURL',
          'url',
          'params',
          'data',
          'headers',
        ]);
        const { method, url = '', params = {}, data = {} } = queryConfig;
        const queryError = {
          status: get(err, 'status', 0),
          statusText: get(err, 'statusText', ''),
          method,
          baseURL: queryConfig.baseURL,
          url,
          params,
          data,
          config: queryConfig,
          headers: queryConfig.headers,
          error: err.response ? err.response.data : omit(err, ['request', 'config']),
          ip,
          userId,
        };
        //
        await RemoteServerQueryLog.create(queryError);
        //
        SECURE_FIELDS.forEach((secureField) => {
          //
          if (get(err, secureField)) {
            set(err, secureField, '[Filtered]');
          }
        });
        //
        throw err;
      },
    );
  }

  static makeQueryString(query?: { [k: string]: string }): string {
    //
    if (!query) {
      return '';
    }
    return `?${Object.keys(query)
      .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k])}`)
      .join('&')}`;
  }

  async sendRequest<T>(
    m: Method,
    url: string,
    data?: { [k: string]: TodoAny },
    headers?: Headers,
    config?: { cachePeriod?: number; timeout?: number },
  ): Promise<T> {
    const { getDataFromResponse, getErrorFromResponse } = this;
    const cachePeriod =
      typeof config?.cachePeriod === 'number' ? config.cachePeriod : this.cachePeriod;

    // @ts-ignore
    const method: Method = m.toUpperCase();
    let requestTimeoutHandlerId;
    try {
      let cacheKey;
      // @ts-ignore
      if (method === 'GET' && redis && cachePeriod) {
        cacheKey = `${method}_${url}${data ? `_${JSON.stringify(data)}` : ''}`;
        // @ts-ignore
        const res = await redis.getAsync(cacheKey);
        if (res) {
          return JSON.parse(res);
        }
      }
      const { responseType, ...otherHeaders } = headers || {};
      //
      const requestTrack = axios.CancelToken.source();
      requestTimeoutHandlerId = setTimeout(() => {
        requestTrack.cancel();
      }, config?.timeout || this.requestTimeout);
      //
      const requestOptions: RequestConfig = {
        url,
        method,
        headers: otherHeaders,
        timeout: config?.timeout,
        cancelToken: requestTrack.token,
      };
      if (responseType) {
        requestOptions.responseType = responseType;
      }
      if (method === 'GET') {
        requestOptions.params = data;
      } else {
        requestOptions.data = data;
      }
      const res = await this.client(requestOptions);
      const responseData = getDataFromResponse(res);
      // @ts-ignore
      if (method === 'GET' && redis && cachePeriod && typeof cacheKey === 'string') {
        // PX - milliseconds
        // @ts-ignore
        redis.set(cacheKey, JSON.stringify(responseData), 'PX', cachePeriod);
      }
      return responseData;
    } catch (error) {
      const e = error as AxiosError;
      //
      if (requestTimeoutHandlerId) {
        clearTimeout(requestTimeoutHandlerId);
      }
      if (axios.isCancel(e)) {
        throw new DefaultError('Request has been canceled due to timeout', {
          meta: { method: m, url, data, headers, config },
        });
      }
      //
      throw getErrorFromResponse(e);
    }
  }
}
