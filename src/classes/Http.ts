import axios, { AxiosHeaders, AxiosRequestConfig, AxiosResponse } from 'axios';

const graphBaseUrl = new URL('https://graph.microsoft.com/v1.0/');

/** HTTP statuses Microsoft Graph uses for throttling and temporary problems */
const retryableStatuses = [429, 503, 504];

export interface IRetryOptions
{
    /** Number of retries after the first attempt (default: 3) */
    retryLimit?: number;
    /** Used to wait between attempts (can be replaced in tests) */
    sleep?: (ms: number)=>Promise<void>;
}

export interface IRequestTimeouts
{
    connect: number;
    overall: number;
}

/** Build a URL below the fixed Microsoft Graph v1.0 endpoint. */
export function graphUrl(path: string): string
{
    if(/^([a-z][a-z\d+.-]*:)?\/\//i.test(path) || path.startsWith('/'))
        throw new Error('Absolute Graph URLs are not allowed');

    const url = new URL(path, graphBaseUrl);
    if(url.origin !== graphBaseUrl.origin || !url.pathname.startsWith(graphBaseUrl.pathname))
        throw new Error('Invalid Graph URL');

    return url.toString();
}

export function graphUserUrl(user: string, endpoint: string): string
{
    return graphUrl(`users/${encodeURIComponent(user)}/${endpoint}`);
}

/** Send an Axios request with separate connection and overall upload timeouts. */
export async function axiosUploadRequest<RequestData = any, ResponseData = any>(
    request: AxiosRequestConfig<RequestData>,
    timeouts: IRequestTimeouts = {connect: 10000, overall: 120000},
): Promise<AxiosResponse<ResponseData, RequestData>>
{
    const abortController = new AbortController();
    const connectTimeout = setTimeout(()=>abortController.abort(new Error(`Server did not respond within ${timeouts.connect}ms`)), timeouts.connect);
    const overallTimeout = setTimeout(()=>abortController.abort(new Error(`Failed to send message within ${timeouts.overall}ms`)), timeouts.overall);
    const onUploadProgress = request.onUploadProgress;

    try {
        return await axios<ResponseData, AxiosResponse<ResponseData, RequestData>, RequestData>({
            ...request,
            signal: abortController.signal,
            onUploadProgress: progress=>{
                clearTimeout(connectTimeout);
                onUploadProgress?.(progress);
            },
        });
    } catch(error) {
        if(axios.isCancel(error) && abortController.signal.aborted)
            throw abortController.signal.reason;
        throw error;
    } finally {
        clearTimeout(connectTimeout);
        clearTimeout(overallTimeout);
    }
}

/** Get the delay (in milliseconds) from a `Retry-After` header that contains seconds */
export function retryAfterMs(headers: unknown): number|undefined
{
    // Node.js delivers header names in lower case, AxiosHeaders.get() matches case-insensitive
    const value = String(AxiosHeaders.from(headers as AxiosHeaders).get('retry-after') ?? '').trim();
    return /^\d+$/.test(value)?parseInt(value)*1000:undefined;
}

/**
 * Send a request and retry it when Graph throttles us or is temporarily unavailable.
 * `createRequest` is called for every attempt, because a streamed body can only be read once.
 */
export async function axiosRetryableRequest<RequestData = any, ResponseData = any>(
    createRequest: ()=>AxiosRequestConfig<RequestData>,
    options: IRetryOptions = {},
): Promise<AxiosResponse<ResponseData, RequestData>>
{
    const retryLimit = options.retryLimit ?? 3;
    const sleep = options.sleep ?? ((ms: number)=>new Promise<void>(resolve=>setTimeout(resolve, ms)));
    let wait = 200;

    for(let attempt = 0; ; attempt++)
    {
        try {
            return await axiosUploadRequest<RequestData, ResponseData>(createRequest());
        } catch(error) {
            if(attempt >= retryLimit || !axios.isAxiosError(error) || !retryableStatuses.includes(error.response?.status ?? 0))
                throw error;

            wait = retryAfterMs(error.response?.headers) ?? wait*2;
            await sleep(wait);
        }
    }
}
