// Operator-only Devnet setup. Defaults to inspection; --send explicitly authorizes a transaction.
import { readFile } from "node:fs/promises";
import { Connection, Keypair, PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { authorityPda, setAuthority, assertDevnet } from "../shared/protocol.mjs";
import manifest from "../shared/deployment.mjs";

const args = process.argv.slice(2);
function option(name) { const i = args.indexOf(name); return i >= 0 ? args[i+1] : undefined; }
if (args.includes("--help") || !option("--authority")) {
  console.log("node scripts/set-sender-authority.mjs --authority PUBLIC_KEY [--program PUBLIC_KEY] [--rpc DEVNET_URL] [--send --upgrade-keypair FILE]");
  console.log("Inspect auth3 by default. --send requires the program upgrade authority; an already matching setting is left unchanged.");
  process.exit(args.includes("--help") ? 0 : 1);
}
const program = new PublicKey(option("--program") || manifest.program);
const desired = new PublicKey(option("--authority"));
const rpc = new Connection(option("--rpc") || "https://api.devnet.solana.com","confirmed");
await assertDevnet(rpc);
const loader = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const executable = await rpc.getAccountInfo(program);
if (!executable?.owner.equals(loader) || executable.data.length !== 36 || executable.data.readUInt32LE(0) !== 2)
  throw Error("Expected an upgradeable program account.");
const programData = new PublicKey(executable.data.subarray(4,36));
const pd = await rpc.getAccountInfo(programData);
if (!pd?.owner.equals(loader) || pd.data.length < 45 || pd.data.readUInt32LE(0) !== 3 || pd.data[12] !== 1)
  throw Error("Program has no active upgrade authority.");
const upgradeAuthority = new PublicKey(pd.data.subarray(13,45));
const current = await rpc.getAccountInfo(authorityPda(program));
if (current && (!current.owner.equals(program) || current.data.length !== 33 || current.data[0] !== 36))
  throw Error("Invalid existing auth3 account.");
console.log({program:String(program),upgradeAuthority:String(upgradeAuthority),authority:String(desired),current:current ? String(new PublicKey(current.data.subarray(1))) : null});
if (current?.data.subarray(1).equals(desired.toBuffer())) { console.log("Already configured."); process.exit(0); }
if (!args.includes("--send")) { console.log("Inspection only; no transaction sent."); process.exit(0); }
if (!option("--upgrade-keypair")) throw Error("--upgrade-keypair is required with --send.");
const signer = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(option("--upgrade-keypair"),"utf8"))));
if (!signer.publicKey.equals(upgradeAuthority)) throw Error("Signer is not the current program upgrade authority.");
const tx = new Transaction().add(setAuthority(program,signer.publicKey,desired,programData));
console.log("Confirmed:",await sendAndConfirmTransaction(rpc,tx,[signer],{commitment:"confirmed",skipPreflight:false}));
const saved = await rpc.getAccountInfo(authorityPda(program));
if (!saved?.owner.equals(program) || saved.data.length !== 33 || saved.data[0] !== 36 || !saved.data.subarray(1).equals(desired.toBuffer()))
  throw Error("Authority verification failed.");
