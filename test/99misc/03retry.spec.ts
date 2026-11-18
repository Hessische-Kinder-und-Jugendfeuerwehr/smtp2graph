import http from 'http';
import { AddressInfo } from 'net';
import { Readable } from 'stream';
import { AxiosHeaders } from 'axios';
import { expect } from 'chai';
import '../_config';
import { axiosRetryableRequest, retryAfterMs } from '../../src/classes/Http';

/** Local HTTP server that answers with the given statuses (in order) and records every received body */
async function startServer(responses: {status: number, headers?: http.OutgoingHttpHeaders}[])
{
    const bodies: string[] = [];
    const server = http.createServer((req, res)=>{
        const chunks: Buffer[] = [];
        req.on('data', chunk=>chunks.push(chunk));
        req.on('end', ()=>{
            bodies.push(Buffer.concat(chunks).toString());
            const response = responses[Math.min(bodies.length, responses.length)-1];
            res.writeHead(response.status, response.headers);
            res.end();
        });
    });
    await new Promise<void>(resolve=>server.listen(0, '127.0.0.1', resolve));

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/sendMail`,
        bodies,
        close: ()=>new Promise<void>(resolve=>server.close(()=>resolve())),
    };
}

describe('Retrying Graph requests', function(){
    it('Sends the complete body again after being throttled', async function(){
        const server = await startServer([{status: 429}, {status: 202}]);
        const body = 'x'.repeat(100000);
        const waits: number[] = [];

        try {
            const response = await axiosRetryableRequest(()=>({
                method: 'post',
                url: server.url,
                data: Readable.from([body]), // A stream can only be read once
            }), {sleep: async ms=>{waits.push(ms)}});

            expect(response.status).to.equal(202);
            expect(server.bodies).to.have.length(2);
            expect(server.bodies[0]).to.equal(body);
            expect(server.bodies[1]).to.equal(body);
            expect(waits).to.deep.equal([400]);
        } finally {
            await server.close();
        }
    });

    it('Waits as long as the Retry-After header asks', async function(){
        const server = await startServer([{status: 503, headers: {'Retry-After': '7'}}, {status: 202}]);
        const waits: number[] = [];

        try {
            await axiosRetryableRequest(()=>({method: 'post', url: server.url, data: 'message'}), {sleep: async ms=>{waits.push(ms)}});
            expect(waits).to.deep.equal([7000]);
        } finally {
            await server.close();
        }
    });

    it('Gives up after the retry limit', async function(){
        const server = await startServer([{status: 504}]);
        let attempts = 0;

        try {
            await expect(axiosRetryableRequest(()=>{
                attempts++;
                return {method: 'post', url: server.url, data: 'message'};
            }, {retryLimit: 2, sleep: async ()=>{}})).to.eventually.be.rejected.and.have.nested.property('response.status', 504);
            expect(attempts).to.equal(3);
        } finally {
            await server.close();
        }
    });

    it('Does not retry other errors', async function(){
        const server = await startServer([{status: 400}]);
        let attempts = 0;

        try {
            await expect(axiosRetryableRequest(()=>{
                attempts++;
                return {method: 'post', url: server.url, data: 'message'};
            }, {sleep: async ()=>{}})).to.eventually.be.rejected.and.have.nested.property('response.status', 400);
            expect(attempts).to.equal(1);
        } finally {
            await server.close();
        }
    });

    it('Reads Retry-After regardless of the header name case', function(){
        expect(retryAfterMs(AxiosHeaders.from({'retry-after': '3'}))).to.equal(3000);
        expect(retryAfterMs({'Retry-After': ' 5 '})).to.equal(5000);
        expect(retryAfterMs({'Retry-After': 'Wed, 21 Oct 2015 07:28:00 GMT'})).to.equal(undefined);
        expect(retryAfterMs({})).to.equal(undefined);
        expect(retryAfterMs(undefined)).to.equal(undefined);
    });
});
