import { expect } from 'chai';
import '../_config';
import { ipMatches } from '../../src/classes/Config';

describe('IP whitelist matching', function(){
    it('Matches single addresses', function(){
        expect(ipMatches('127.0.0.1', '127.0.0.1')).to.equal(true);
        expect(ipMatches('127.0.0.1', '127.0.0.2')).to.equal(false);
        expect(ipMatches('2001:db8::1', '2001:0db8:0:0:0:0:0:1')).to.equal(true);
    });

    it('Matches CIDR ranges', function(){
        expect(ipMatches('127.0.0.1', '127.0.0.0/8')).to.equal(true);
        expect(ipMatches('172.18.0.5', '172.16.0.0/12')).to.equal(true);
        expect(ipMatches('10.1.2.3', '172.16.0.0/12')).to.equal(false);
        expect(ipMatches('2001:db8::1', '2001:db8::/32')).to.equal(true);
        expect(ipMatches('2001:db9::1', '2001:db8::/32')).to.equal(false);
    });

    it('Treats IPv4-mapped IPv6 clients as IPv4', function(){
        expect(ipMatches('::ffff:172.18.0.5', '172.18.0.0/16')).to.equal(true);
        expect(ipMatches('::ffff:172.19.0.5', '172.18.0.0/16')).to.equal(false);
    });

    it('Never matches across address families', function(){
        expect(ipMatches('::1', '0.0.0.0/0')).to.equal(false);
        expect(ipMatches('127.0.0.1', '::/0')).to.equal(false);
    });

    it('Rejects invalid entries and addresses', function(){
        expect(ipMatches('127.0.0.1', '127.0.0.0/999')).to.equal(false);
        expect(ipMatches('127.0.0.1', '127.0.0.0/8/8')).to.equal(false);
        expect(ipMatches('127.0.0.1', '127.0.0.0/')).to.equal(false);
        expect(ipMatches('127.0.0.1', 'localhost')).to.equal(false);
        expect(ipMatches('127.0.0.1', '')).to.equal(false);
        expect(ipMatches('not-an-ip', '0.0.0.0/0')).to.equal(false);
    });

    it('Does not guess the meaning of leading zeros', function(){
        // "010" could mean 10 (decimal) or 8 (octal), so such entries never match
        expect(ipMatches('10.0.0.1', '010.0.0.0/8')).to.equal(false);
        expect(ipMatches('8.0.0.1', '010.0.0.0/8')).to.equal(false);
    });
});
