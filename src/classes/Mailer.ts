import fs from 'fs';
import readline from 'readline';
import { Mutex, Semaphore } from 'async-mutex';
import { isAxiosError } from 'axios';
import { Base64Encode } from 'base64-stream';
import addressparser from 'nodemailer/lib/addressparser';
import { ConfidentialClientApplication } from '@azure/msal-node';
import { Config } from './Config';
import { axiosRetryableRequest, graphUserUrl } from './Http';
import { UnrecoverableError } from './Constants';
import { MsalProxy } from './MsalProxy';

export class MailboxAccessDenied extends UnrecoverableError { }
export class InvalidMailContent extends UnrecoverableError { }
export class MessageSizeExceeded extends UnrecoverableError { }

export class Mailer
{
    /** Prevent getting an accesstoken in parallel */
    static #aquireTokenMutex = new Mutex();
    /** Prevent sending more than 4 messages in parallel (see: https://learn.microsoft.com/en-us/graph/throttling-limits#outlook-service-limits) */
    static #sendSemaphore = new Semaphore(4);

    static #msalClient = (Config.clientId && (Config.clientSecret || (Config.clientCertificateThumbprint && Config.clientCertificateKeyPath)))?new ConfidentialClientApplication({
        auth: {
            authority: Config.msalAuthority,
            clientId: Config.clientId,
            clientSecret: Config.clientSecret,
            clientCertificate: Config.clientCertificateThumbprint && Config.clientCertificateKeyPath?{
                thumbprint: Config.clientCertificateThumbprint,
                privateKey: Config.clientCertificateKey!,
            }:undefined,
        },
        system: Config.httpProxyConfig?{networkClient: new MsalProxy()}:undefined, // We use our custom implementation, because the `proxyUrl` property doesn't want to work
    }):undefined;

    static async sendEml(filePath: string)
    {
        return this.#sendSemaphore.runExclusive(async ()=>{
            // Determine the sender
            let sender = Config.forceMailbox;
            if(!sender) // There's no forced sender in the config, so we get it from the mail data
            {
                const senderObj = await this.#findSender(filePath);
                if(!senderObj) throw new UnrecoverableError('No sender/from address defined');
                sender = senderObj.address;
            }

            // Fetch an accesstoken if needed
            const token = await this.#aquireToken();

            // Send the message. Every attempt opens the file again, because a stream can only be read once
            const url = graphUserUrl(sender, 'sendMail');
            const readStreams: fs.ReadStream[] = [];
            try {
                await axiosRetryableRequest(()=>{
                    const readStream = fs.createReadStream(filePath);
                    readStreams.push(readStream);
                    return {
                        method: 'post',
                        url,
                        data: readStream.pipe(new Base64Encode()),
                        headers: {
                            Authorization: `Bearer ${token}`,
                            'Content-Type': 'text/plain',
                            'User-Agent': `SMPT2Graph/${VERSION}`,
                        },
                        proxy: Config.httpProxyConfig,
                    };
                });
            } catch(error: any) {
                if(isAxiosError(error) && error.response?.data)
                {
                    const data = error.response?.data;
                    if('error' in data && 'code' in data.error)
                    {
                        if(data.error.code === 'ErrorAccessDenied')
                            throw new MailboxAccessDenied(`Access to mailbox "${sender}" denied`);
                        else if(data.error.code === 'ErrorMimeContentInvalidBase64String')
                            throw new InvalidMailContent(`Invalid content for mail "${filePath}"`);
                        else if(data.error.code === 'ErrorMessageSizeExceeded')
                            throw new MessageSizeExceeded(`The message exceeds the maximum supported size for mail "${filePath}"`);
                        else
                            throw new Error(JSON.stringify(data.error));
                    }
                    else
                        throw data;
                }
                else
                    throw error;
            } finally {
                for(const readStream of readStreams)
                    readStream.destroy();
            }
        });
    }

    /** Get sender address from EML/RFC822 data */
    static async #findSender(filePath: string)
    {
        const readStream = fs.createReadStream(filePath);
        const reader = readline.createInterface({
            input: readStream,
            crlfDelay: Infinity, // To treat \r\n and \n the same
        });

        let currentHeader: string | null = null;

        const tryParseCurrentHeader = () => {
            if (currentHeader === null) return null;
            if (
                currentHeader.toLowerCase().startsWith('sender:') ||
                currentHeader.toLowerCase().startsWith('from:')
            ) {
                const parsed = addressparser(
                    currentHeader.substring(currentHeader.indexOf(':') + 1),
                    { flatten: true }
                );
                if (parsed.length && parsed[0].address) {
                    return parsed[0];
                }
            }
            return null;
        };

        for await (const line of reader)
        {
            if (line === '') // We've reached the end of the headers?
            {
                const result = tryParseCurrentHeader();
                if (result) {
                    readStream.destroy();
                    return result;
                }
                break;
            }
            else if (/^[ \t]/.test(line)) // Folded continuation line
            {
                if (currentHeader !== null) {
                    // Unfold per RFC 5322: replace the fold with a single space
                    currentHeader += ' ' + line.trim();
                }
                // If currentHeader is null, this is a stray continuation with no
                // preceding header (malformed) — safely ignore it.
            }
            else // New header line — check the previous one, then start fresh
            {
                const result = tryParseCurrentHeader();
                if (result) {
                    readStream.destroy();
                    return result;
                }
                currentHeader = line;
            }
        }

        // In case the header block ended without a trailing blank line
        const result = tryParseCurrentHeader();
        if (result) {
            readStream.destroy();
            return result;
        }

        readStream.destroy();
        return undefined;
    }

    static async #aquireToken(): Promise<string>
    {
        return this.#aquireTokenMutex.runExclusive(async ()=>{
            if(!this.#msalClient) throw new UnrecoverableError('Trying to login without an application registration');

            const res = await this.#msalClient.acquireTokenByClientCredential({
                scopes: ['https://graph.microsoft.com/.default'],
            });
            return res?.accessToken!;
        });
    }

}
