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
      return { status: "PENDING", hash: `${calls.send.length}`.repeat(64) };
    },
    getTransaction: async () =>
      ++calls.getTransaction % 2 === 1
        ? { status: rpc.Api.GetTransactionStatus.NOT_FOUND }
        : { status: rpc.Api.GetTransactionStatus.SUCCESS, returnValue: nativeToScVal(42, { type: "u32" }) },
  };
  return server;
}

function createClient(server: any) {
  return new SorobanContractClient({
    server,
    escrowContractId: CONTRACT_ID,
    usdcContractId: CONTRACT_ID,
    pollIntervalMs: 1,
  });
}

describe("SorobanContractClient RPC pipeline", () => {
  it("simulates, assembles, signs, sends and polls until confirmed", async () => {
    const server = createMockServer([successSimulation()]);
    const res = await createClient(server).createLeague(admin.secret(), admin.publicKey(), 7, 10n);

    assert.equal(res.success, true);
    assert.equal(res.txHash, "1".repeat(64));
    assert.equal(res.returnValue, 42);
    assert.deepEqual(server.calls.send, ["invokeHostFunction"]);
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
    assert.deepEqual(server.calls.send, ["restoreFootprint", "invokeHostFunction"]);
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

  it("returns a true zero balance but rejects failed or empty audit reads", async () => {
    const zeroBalance = createClient(
      createMockServer([successSimulation(nativeToScVal(0n, { type: "i128" }))])
    );
    assert.equal(await zeroBalance.getTokenBalanceForAudit(admin.publicKey()), 0n);

    const failedRead = createClient(
      createMockServer([
        { id: "1", latestLedger: 100, events: [], _parsed: true, error: "RPC simulation failed" },
      ])
    );
    await assert.rejects(
      () => failedRead.getTokenBalanceForAudit(admin.publicKey()),
      /Unable to audit token balance/
    );

    const emptyRead = createClient(createMockServer([successSimulation()]));
    await assert.rejects(
      () => emptyRead.getTokenBalanceForAudit(admin.publicKey()),
      /no token balance value/
    );
  });
});
