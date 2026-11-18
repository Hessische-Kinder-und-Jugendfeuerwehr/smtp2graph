import fs from 'fs';
import os from 'os';
import path from 'path';
import { expect } from 'chai';
import { stringify } from 'yaml';
import '../_config';
import { UnrecoverableError } from '../../src/classes/Constants';

// The mailer loads the config as soon as it's imported, so point it to a test config first
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'smtp2graph-'));
const configFile = path.join(tmpRoot, 'config.yml');
fs.writeFileSync(configFile, stringify({
    mode: 'full',
    send: {
        appReg: {tenant: 'contoso', id: '01234567-89ab-cdef-0123-456789abcdef', secret: 'not-used'},
        retryLimit: 3,
        retryInterval: 1,
    },
}));
process.argv.push(`--config=${configFile}`);

// Normally defined by webpack (see webpack.config.js)
Object.assign(globalThis, {VERSION: 'test', DEBUG: false});

async function waitFor(condition: ()=>boolean, timeout = 3000)
{
    const start = Date.now();
    while(!condition())
    {
        if(Date.now()-start > timeout) throw new Error('A timeout occured waiting for the condition');
        await new Promise(resolve=>setTimeout(resolve, 25));
    }
}

describe('Mail queue', function(){
    let MailerModule: typeof import('../../src/classes/Mailer');
    let MailQueueModule: typeof import('../../src/classes/MailQueue');
    let originalSendEml: typeof MailerModule.Mailer.sendEml;

    before(function(){
        // Loaded here (not at the top), so the test config above is used
        MailerModule = require('../../src/classes/Mailer');
        MailQueueModule = require('../../src/classes/MailQueue');
        originalSendEml = MailerModule.Mailer.sendEml;
    });

    afterEach(function(){
        MailerModule.Mailer.sendEml = originalSendEml;
    });

    it('Retries temporary errors and "access denied", but not other unrecoverable errors', function(){
        const { shouldRetry } = MailQueueModule;
        const { MailboxAccessDenied, InvalidMailContent, MessageSizeExceeded } = MailerModule;

        expect(shouldRetry(new Error('Timeout'))).to.equal(true);
        expect(shouldRetry(new MailboxAccessDenied('Access denied'))).to.equal(true);
        expect(shouldRetry(new InvalidMailContent('Invalid content'))).to.equal(false);
        expect(shouldRetry(new MessageSizeExceeded('Too big'))).to.equal(false);
        expect(shouldRetry(new UnrecoverableError('No sender'))).to.equal(false);
    });

    it('Moves a message that can never be sent to the failed folder', async function(){
        const root = path.join(tmpRoot, 'unrecoverable');
        const attempts: string[] = [];
        MailerModule.Mailer.sendEml = async (filePath: string)=>{
            attempts.push(filePath);
            throw new MailerModule.InvalidMailContent('Invalid content');
        };

        new MailQueueModule.MailQueue(root);
        fs.writeFileSync(path.join(root, 'queue', 'message.eml'), 'From: sender@example.com\r\n\r\nTest');

        await waitFor(()=>fs.existsSync(path.join(root, 'failed', 'message.eml')));
        expect(fs.existsSync(path.join(root, 'queue', 'message.eml'))).to.equal(false);
        expect(attempts).to.have.length(1);
    });

    it('Keeps a message in the queue for a retry when Graph denies access', async function(){
        const root = path.join(tmpRoot, 'accessdenied');
        const attempts: string[] = [];
        MailerModule.Mailer.sendEml = async (filePath: string)=>{
            attempts.push(filePath);
            throw new MailerModule.MailboxAccessDenied('Access denied');
        };

        new MailQueueModule.MailQueue(root);
        fs.writeFileSync(path.join(root, 'queue', 'message.eml'), 'From: sender@example.com\r\n\r\nTest');

        await waitFor(()=>attempts.length === 1);
        await new Promise(resolve=>setTimeout(resolve, 200));
        expect(fs.existsSync(path.join(root, 'queue', 'message.eml'))).to.equal(true);
        expect(fs.existsSync(path.join(root, 'failed', 'message.eml'))).to.equal(false);
    });
});
