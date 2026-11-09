import test from 'node:test';import assert from 'node:assert/strict';
import {assertDevnet,DEVNET_GENESIS} from '../app/protocol.mjs';
test('network guard accepts the full official Devnet genesis, fails closed for every other cluster',async()=>{
 assert.equal(DEVNET_GENESIS,'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG');
 await assertDevnet({getGenesisHash:async()=>DEVNET_GENESIS});
 for(const hash of ['5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',DEVNET_GENESIS.slice(0,32),''])await assert.rejects(assertDevnet({getGenesisHash:async()=>hash}));
 await assert.rejects(assertDevnet({getGenesisHash:async()=>{throw Error('offline');}}));
});
