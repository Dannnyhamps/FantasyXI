import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  Account,
  Keypair,
  SorobanDataBuilder,
  StrKey,
  nativeToScVal,
  rpc,
  xdr,
} from "@stellar/stellar-sdk";
import { SorobanContractClient } from "../services/financial/sorobanContractClient.js";
import { MemorySorobanReplayStore } from "./helpers/sorobanReplayStore.js";

const CONTRACT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const admin = Keypair.random();

function successSimulation(retval: xdr.ScVal = xdr.ScVal.scvVoid()) {
  return {
    _parsed: true,
    id: "1",
    latestLedger: 100,
    events: [],
    minResourceFee: "100",
    transactionData: new SorobanDataBuilder(),
    result: { auth: [], retval },
  };
}

function createMockServer(simulations: any[]) {
  const calls = { simulate: 0, send: [] as string[], getTransaction: 0 };
  const server: any = {
    calls,
    getAccount: async (pub: string) => new Account(pub, "1"),
    simulateTransaction: async () => simulations[calls.simulate++],
    sendTransaction: async (tx: any) => {
      calls.send.push(tx.operations[0].type);
      return { status: "PENDING", hash: Buffer.from(tx.hash()).toString("hex") };
    },
    getTransaction: async () =>
      ++calls.getTransaction % 2 === 1
        ? {
            status: rpc.Api.GetTransactionStatus.NOT_FOUND,
            latestLedgerCloseTime: Math.floor(Date.now() / 1000),
          }
        : {
            status: rpc.Api.GetTransactionStatus.SUCCESS,
            ledger: 101,
            returnValue: nativeToScVal(42, { type: "u32" }),
          },
  };
  return server;
}

function createClient(server: any) {
  return new SorobanContractClient({
    server,
    escrowContractId: CONTRACT_ID,
    usdcContractId: CONTRACT_ID,
    pollIntervalMs: 1,
    replayStore: new MemorySorobanReplayStore(),
  });
}

describe("SorobanContractClient RPC pipeline", () => {
  it("simulates, assembles, signs, sends and polls until confirmed", async () => {
    const server = createMockServer([successSimulation()]);
    const res = await createClient(server).createLeague(admin.secret(), admin.publicKey(), 7, 10n);

    assert.equal(res.success, true);
    assert.equal(res.txHash?.length, 64);
    assert.equal(res.returnValue, 42);
    assert.deepEqual(server.calls.send, ["invokeHostFunction", "invokeHostFunction"]);
    assert.equal(server.calls.getTransaction, 2);
  });

  it("restores an archived footprint before invoking", async () => {
    const restore = {
      ...successSimulation(),
      restorePreamble: { minResourceFee: "500", transactionData: new SorobanDataBuilder() },
    };
    const server = createMockServer([restore, successSimulation()]);
    const res = await createClient(server).deposit(admin.secret(), admin.publicKey(), 7);

    assert.equal(res.success, true);
    assert.deepEqual(server.calls.send, [
      "restoreFootprint",
      "restoreFootprint",
      "invokeHostFunction",
      "invokeHostFunction",
    ]);
    assert.equal(server.calls.simulate, 2);
  });

  it("returns the contract error code when simulation fails", async () => {
    const server = createMockServer([
      { id: "1", latestLedger: 100, events: [], _parsed: true, error: "HostError: Error(Contract, #6)" },
    ]);
    const res = await createClient(server).deposit(admin.secret(), admin.publicKey(), 7);

    assert.equal(res.success, false);
    assert.equal(res.contractErrorCode, 6);
    assert.deepEqual(server.calls.send, []);
  });

  it("decodes read-only results without submitting", async () => {
    const state = nativeToScVal({
      creator: admin.publicKey(),
      entry_fee: nativeToScVal(10n, { type: "i128" }),
      participant_count: nativeToScVal(2, { type: "u32" }),
      status: nativeToScVal(0, { type: "u32" }),
      total_deposited: nativeToScVal(20n, { type: "i128" }),
    });
    const server = createMockServer([successSimulation(state), successSimulation()]);
    const client = createClient(server);

    assert.deepEqual(await client.getLeague(7), {
      creator: admin.publicKey(),
      entry_fee: 10n,
      participant_count: 2,
      status: 0,
      total_deposited: 20n,
    });
    assert.equal(await client.getLeague(8), null);
    assert.deepEqual(server.calls.send, []);
  });
});
