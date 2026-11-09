# Working on wara.monku.ai

Read README.md and HOSTING.md. The Cloudflare Worker serves the Devnet wallet and same-origin auth API. Keep the existing Worker, D1 binding and secret when deploying an update. The trial uses simulated SMS and Solana Devnet only. Store dedicated test keypairs in ignored private/. Build the on-chain program and run npm test and npm run workers:build before deployment.

The v0.3 limit is 10 Kusa per wallet across communities per JST day. Each Kusa mints 90 WARA to the shop and 10 to the buyer. Keep the separate 300-limit /devnet/ instructions working. The /mock/ route bundles a snapshot of the original offline demonstration. Update the original concept and mock in emergency-straw-protocol.
